/**
 * Resolves the MCP server URL used by package:plugin and check:connector.
 *
 * The committed manifest deliberately carries a placeholder host so the repo
 * never ships one developer's tunnel. Two ways to point the tooling at a real
 * server, in precedence order:
 *
 *   1. MCP_SERVER_URL in the environment  — explicit, wins over everything.
 *   2. the .tunnel-url file               — written by scripts/resolve-tunnel-url.mjs,
 *                                           which the VS Code "Run with Dev Tunnel"
 *                                           launch runs automatically. Git-ignored.
 *
 * Neither path rewrites manifest.json on disk.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const TUNNEL_URL_FILE = join(ROOT, ".tunnel-url");
export const PLACEHOLDER = "REPLACE-WITH-YOUR-TUNNEL";

/**
 * @returns {{url: string, source: string} | null} the resolved URL and where it
 * came from, or null when neither source is present.
 */
export function resolveServerUrl() {
  const fromEnv = process.env.MCP_SERVER_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: "MCP_SERVER_URL" };

  if (existsSync(TUNNEL_URL_FILE)) {
    // Ignore blank lines and #-comments so the file stays hand-editable.
    const line = readFileSync(TUNNEL_URL_FILE, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#"));
    if (line) return { url: line, source: ".tunnel-url" };
  }

  return null;
}

/**
 * Validates an absolute HTTPS URL and returns its host.
 * @returns {{host: string} | {error: string}}
 */
export function parseHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return { error: "it must use https." };
    return { host: parsed.host };
  } catch {
    return { error: "it is not a valid absolute URL." };
  }
}

/** Shown whenever no URL could be resolved. */
export const HOW_TO_SET_URL =
  `Start the "Run with Dev Tunnel" launch profile in VS Code (it writes .tunnel-url\n` +
  `for you), or set the URL explicitly:\n` +
  `  $env:MCP_SERVER_URL = "https://<id>-3000.<region>.devtunnels.ms/mcp"   # PowerShell\n` +
  `  MCP_SERVER_URL=https://<id>-3000.<region>.devtunnels.ms/mcp            # bash\n` +
  `or run: npm run tunnel:url`;
