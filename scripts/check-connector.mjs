/**
 * Smoke-tests the packaged connector against the mcpServerUrl in the manifest:
 * initialize -> notifications/initialized -> tools/list, then checks that every
 * tool named in tools/*.json is actually exposed by the live server with
 * matching annotations.
 *
 * Also verifies the MCP apps (widget) contract that Copilot Cowork enforces at
 * runtime, which the package validator cannot see: ui:// resourceUri, "app"
 * visibility for widget-initiated calls, a `text` HTML body with the mcp-app
 * mime type, and the 64 KiB inline tool-result cap.
 *
 * Run after starting the server and the dev tunnel.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "cowork-plugin");
const manifest = JSON.parse(readFileSync(join(PKG_DIR, "manifest.json"), "utf8"));

const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

/** Streamable HTTP replies may be JSON or a single SSE frame. */
async function parseBody(res) {
  const text = await res.text();
  if (!text.trim()) return null;
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("data:"));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }
  return JSON.parse(text);
}

async function rpc(url, body, sessionId) {
  const res = await fetch(url, {
    method: "POST",
    headers: sessionId ? { ...HEADERS, "mcp-session-id": sessionId } : HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${body.method} -> HTTP ${res.status}: ${await res.text()}`);
  return { json: await parseBody(res), sessionId: res.headers.get("mcp-session-id") ?? sessionId };
}

let failed = false;

for (const connector of manifest.agentConnectors ?? []) {
  const remote = connector.toolSource?.remoteMcpServer;
  if (!remote) continue;

  const url = remote.mcpServerUrl;
  console.log(`\n${connector.id} -> ${url}`);

  const init = await rpc(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cowork-connector-smoketest", version: "1.0.0" },
    },
  });
  const sid = init.sessionId;
  console.log(`  initialize    ok (server: ${init.json?.result?.serverInfo?.name}, session: ${sid ? "yes" : "none"})`);

  await fetch(url, {
    method: "POST",
    headers: sid ? { ...HEADERS, "mcp-session-id": sid } : HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const list = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
  const live = list.json?.result?.tools ?? [];
  console.log(`  tools/list    ok (${live.length}: ${live.map((t) => t.name).join(", ")})`);

  // --- MCP apps (widget) conformance ---------------------------------------
  // Checks the contract in the Cowork MCP apps author guide. These are runtime
  // rules the package validator cannot see, because they live in the server's
  // tools/list and resources/read responses rather than in the .zip.
  for (const tool of live) {
    const ui = tool._meta?.ui;
    if (!ui) continue;

    console.log(`\n  widget contract for '${tool.name}':`);

    if (!ui.resourceUri?.startsWith("ui://")) {
      console.error(`    resourceUri '${ui.resourceUri}' must use the ui:// scheme, or no widget renders.`);
      failed = true;
      continue;
    }
    if (ui.resourceUri.length > 1024) {
      console.error(`    resourceUri exceeds the 1024-character limit.`);
      failed = true;
    }
    console.log(`    resourceUri   ${ui.resourceUri}`);

    // The widget calls tools back through the host, and the host enforces
    // visibility at call time: a declared visibility without "app" refuses
    // widget-initiated tools/call.
    if (ui.visibility) {
      if (!ui.visibility.includes("model")) {
        console.warn(`    visibility omits "model" — the agent cannot call '${tool.name}'.`);
      }
      if (!ui.visibility.includes("app")) {
        console.error(`    visibility omits "app" — widget-initiated calls to '${tool.name}' are refused.`);
        failed = true;
      } else {
        console.log(`    visibility    [${ui.visibility.join(", ")}]`);
      }
    } else {
      console.log(`    visibility    (omitted -> defaults to model + app)`);
    }

    const read = await rpc(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: ui.resourceUri },
    }, sid);

    const entry = read.json?.result?.contents?.[0];
    if (!entry) {
      console.error(`    resources/read returned no contents for ${ui.resourceUri}.`);
      failed = true;
      continue;
    }
    if (!entry.text) {
      console.error(`    resources/read returned no 'text' body. Cowork does not decode base64 'blob' bodies.`);
      failed = true;
    } else {
      console.log(`    html          ${(entry.text.length / 1024).toFixed(1)} KB via 'text'`);
    }
    if (entry.mimeType !== "text/html;profile=mcp-app") {
      console.warn(`    mimeType is '${entry.mimeType}', expected 'text/html;profile=mcp-app'.`);
    } else {
      console.log(`    mimeType      ${entry.mimeType}`);
    }
    if (/<script[^>]+src=|<link[^>]+href=|@import/i.test(entry.text ?? "")) {
      console.warn(`    widget references external assets; the sandboxed iframe CSP is not author-widenable.`);
    }
  }

  // The tool result is pushed to the widget inline and dropped above 64 KiB.
  const callTarget = live.find((t) => t._meta?.ui && t.annotations?.readOnlyHint);
  if (callTarget) {
    const call = await rpc(url, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: callTarget.name, arguments: {} },
    }, sid);
    const result = call.json?.result ?? {};
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    const cap = 64 * 1024;
    console.log(`\n  tools/call '${callTarget.name}' result: ${bytes} bytes (inline cap ${cap})`);
    if (bytes > cap) {
      console.error(`    Result exceeds 64 KiB; it is not delivered to the widget. Fetch bulk data via tools/call instead.`);
      failed = true;
    }
    if (!result.content?.some((c) => c.type === "text" && c.text)) {
      console.error(`    Result has no text content; the tool must degrade gracefully when no widget renders.`);
      failed = true;
    }
  }

  console.log("");

  const declared = JSON.parse(readFileSync(join(PKG_DIR, remote.mcpToolDescription.file), "utf8")).tools ?? [];
  for (const d of declared) {
    const match = live.find((t) => t.name === d.name);
    if (!match) {
      console.error(`  MISSING       '${d.name}' is declared in the package but not served.`);
      failed = true;
      continue;
    }
    if (!match.annotations) {
      console.error(`  NO ANNOTATION '${d.name}' is served without annotations; Cowork will treat it as destructive.`);
      failed = true;
      continue;
    }
    for (const key of ["readOnlyHint", "destructiveHint"]) {
      if (d.annotations?.[key] !== match.annotations[key]) {
        console.error(
          `  MISMATCH      '${d.name}' ${key}: package says ${d.annotations?.[key]}, server says ${match.annotations[key]}.`
        );
        failed = true;
      }
    }
    console.log(`  ${d.name} matches the packaged description.`);
  }

  if (sid) {
    await fetch(url, { method: "DELETE", headers: { ...HEADERS, "mcp-session-id": sid } });
  }
}

console.log(failed ? "\nConnector check FAILED." : "\nConnector check passed.");
process.exit(failed ? 1 : 0);
