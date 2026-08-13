// Build script for the MCP App widget.
//
// Bundles src/widget.ts (with the @modelcontextprotocol/ext-apps SDK inlined)
// into a single browser IIFE, then injects it into src/widget.html, replacing
// the `<!-- __WIDGET_BUNDLE__ -->` marker. The result is written to
// dist/widget.html, which server.ts serves to the Copilot host.
//
// Inlining keeps the widget a single self-contained HTML file (no CDN imports,
// no extra network round-trips inside the sandboxed iframe).
import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "src/widget.ts");
const htmlSrc = resolve(root, "src/widget.html");
const outDir = resolve(root, "dist");
const htmlOut = resolve(outDir, "widget.html");

const MARKER = "<!-- __WIDGET_BUNDLE__ -->";

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  write: false,
  legalComments: "none",
});

const js = result.outputFiles[0].text;

const html = await readFile(htmlSrc, "utf8");
if (!html.includes(MARKER)) {
  throw new Error(`Bundle marker "${MARKER}" not found in src/widget.html`);
}

// Escape any closing-script sequence so the inlined JS can't break out of the tag.
const safeJs = js.replace(/<\/script>/gi, "<\\/script>");
// Use a function replacement so `$`-sequences in the bundled JS (e.g. zod's
// `"\\$&"` regex-escape helper) are inserted literally, not interpreted by replace().
const finalHtml = html.replace(MARKER, () => `<script type="module">${safeJs}</script>`);

await mkdir(outDir, { recursive: true });
await writeFile(htmlOut, finalHtml, "utf8");

console.log(`Built widget -> ${htmlOut} (${(finalHtml.length / 1024).toFixed(1)} KB)`);
