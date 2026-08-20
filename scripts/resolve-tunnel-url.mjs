/**
 * Resolves the public URL of the persistent "expense-mcp" dev tunnel and writes
 * it to .tunnel-url, so `npm run package:plugin` and `npm run check:connector`
 * pick it up without anyone editing the tracked manifest.
 *
 * The VS Code "Run with Dev Tunnel" launch profile runs this automatically once
 * the tunnel reports ready. You can also run it by hand:
 *
 *   npm run tunnel:url
 *
 * Flags:
 *   --soft   warn instead of failing when the URL cannot be resolved. Used by
 *            the VS Code task so a tunnel hiccup never blocks the debug session.
 *
 * Env:
 *   DEVTUNNEL_NAME   tunnel to inspect (default "expense-mcp")
 *   PORT             port to match inside the tunnel (default 3000)
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { TUNNEL_URL_FILE } from "./tunnel-url.mjs";

const SOFT = process.argv.includes("--soft");
const TUNNEL = process.env.DEVTUNNEL_NAME?.trim() || "expense-mcp";
const PORT = Number(process.env.PORT) || 3000;
const MCP_PATH = "/mcp";

/** Hosting and port registration race the launch, so poll briefly. */
const ATTEMPTS = 5;
const DELAY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function giveUp(message, hint) {
  const text = hint ? `${message}\n${hint}` : message;
  if (SOFT) {
    console.warn(`\n[tunnel-url] ${text}\n[tunnel-url] Continuing; .tunnel-url was left unchanged.`);
    process.exit(0);
  }
  console.error(`\n[tunnel-url] ${text}`);
  process.exit(1);
}

function showTunnel() {
  // execFileSync avoids a shell, so the tunnel name is never word-split.
  return execFileSync("devtunnel", ["show", TUNNEL, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let lastReason = "";

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  let raw;
  try {
    raw = showTunnel();
  } catch (err) {
    if (err.code === "ENOENT") {
      giveUp(
        "The 'devtunnel' CLI was not found on PATH.",
        "Install it from https://aka.ms/devtunnels/download, then run 'devtunnel user login'."
      );
    }
    lastReason = `'devtunnel show ${TUNNEL}' failed: ${(err.stderr || err.message || "").toString().trim()}`;
    await sleep(DELAY_MS);
    continue;
  }

  let tunnel;
  try {
    // The CLI prints a banner before the JSON on some versions; start at the brace.
    tunnel = JSON.parse(raw.slice(raw.indexOf("{"))).tunnel;
  } catch {
    lastReason = "could not parse the JSON from 'devtunnel show'.";
    await sleep(DELAY_MS);
    continue;
  }

  const port = (tunnel?.ports ?? []).find((p) => p.portNumber === PORT);
  if (!port?.portUri) {
    lastReason =
      `tunnel '${TUNNEL}' has no port ${PORT} yet ` +
      `(found: ${(tunnel?.ports ?? []).map((p) => p.portNumber).join(", ") || "none"}).`;
    await sleep(DELAY_MS);
    continue;
  }

  if (!tunnel.hostConnections) {
    lastReason = `tunnel '${TUNNEL}' is not being hosted yet (hostConnections: 0).`;
    await sleep(DELAY_MS);
    continue;
  }

  // portUri carries a trailing slash; the MCP endpoint lives at /mcp.
  const url = port.portUri.replace(/\/+$/, "") + MCP_PATH;

  writeFileSync(
    TUNNEL_URL_FILE,
    `# Written by scripts/resolve-tunnel-url.mjs -- do not commit (git-ignored).\n` +
      `# Tunnel '${TUNNEL}', port ${PORT}, resolved ${new Date().toISOString()}.\n` +
      `${url}\n`,
    "utf8"
  );

  console.log(`[tunnel-url] ${url}`);
  console.log(`[tunnel-url] wrote .tunnel-url; package:plugin and check:connector will use it.`);
  process.exit(0);
}

giveUp(
  `Could not resolve the dev tunnel URL after ${ATTEMPTS} attempts: ${lastReason}`,
  `Check that the tunnel exists ('devtunnel list') and is hosted ('devtunnel host ${TUNNEL}').`
);
