/**
 * Validates and zips ./cowork-plugin into ./dist/cowork-plugin.zip, the M365
 * app package that Copilot Cowork sideloads.
 *
 * Validation mirrors the platform rules documented for Cowork plugins, so most
 * upload rejections are caught here instead of after the fact:
 *   - manifest fields the v1.28 schema requires (it is additionalProperties:false)
 *   - each agentSkills folder exists and holds a SKILL.md with valid frontmatter
 *   - SKILL.md `name` is kebab-case and equals the folder name (ASKILL-P006/P007)
 *   - each remoteMcpServer has an HTTPS url and an mcpToolDescription file in the zip
 *   - companion-file count and size limits per skill
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 as zlibCrc32 } from "node:zlib";
import { PLACEHOLDER, parseHttpsUrl, resolveServerUrl, HOW_TO_SET_URL } from "./tunnel-url.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "cowork-plugin");
const OUT_ZIP = join(ROOT, "dist", "cowork-plugin.zip");

const MAX_COMPANIONS = 20;
const MAX_COMPANION_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_COMPANION_BYTES = 10 * 1024 * 1024;
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const errors = [];
const fail = (msg) => errors.push(msg);

/**
 * Package-relative paths must match the zip entry names *exactly*.
 *
 * The docs write these as './tools/x.json' and './skills/y', but the package
 * service compares the declared string literally against zip entry names, which
 * have no './' prefix. A leading './' therefore fails upload with:
 *   InvalidAgentConnector: ... declared MCP tool description file
 *   ./tools/x.json not found in the app package
 * The bare form matches whether or not the service normalizes, so it is the
 * safe spelling.
 */
function checkPackagePath(value, where) {
  if (value.startsWith("./") || value.startsWith(".\\")) {
    fail(
      `${where} is '${value}'. Remove the leading './' — the package service matches zip entry ` +
        `names literally and rejects the upload with a 400 'not found in the app package'. ` +
        `Use '${value.slice(2)}'.`
    );
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    fail(`${where} is '${value}'. Package paths must be relative.`);
    return false;
  }
  if (value.includes("\\")) {
    fail(`${where} is '${value}'. Use forward slashes; zip entry names are POSIX-style.`);
    return false;
  }
  if (value.split("/").includes("..")) {
    fail(`${where} is '${value}'. Path traversal is not allowed.`);
    return false;
  }
  return true;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// --- manifest ---------------------------------------------------------------
const manifestPath = join(PKG_DIR, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("manifest.json not found in " + PKG_DIR);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

/**
 * The committed manifest ships a placeholder host so the repo carries no one
 * developer's tunnel. The real URL comes from MCP_SERVER_URL or the git-ignored
 * .tunnel-url file (see scripts/tunnel-url.mjs for precedence).
 *
 * The override is applied to the manifest copy written into the zip only; the
 * file on disk is never rewritten.
 */
const override = resolveServerUrl();

if (override) {
  const parsed = parseHttpsUrl(override.url);
  if (parsed.error) {
    fail(
      `The MCP server URL from ${override.source} is '${override.url}', but ${parsed.error}\n` +
        `Expected something like https://<id>-3000.<region>.devtunnels.ms/mcp.`
    );
  }
  for (const c of manifest.agentConnectors ?? []) {
    if (c.toolSource?.remoteMcpServer) c.toolSource.remoteMcpServer.mcpServerUrl = override.url;
  }
  manifest.validDomains = [parsed.host];
  console.log(`Using MCP server URL from ${override.source}: ${override.url}`);
}

for (const field of ["manifestVersion", "version", "id", "developer", "name", "description", "icons", "accentColor"]) {
  if (manifest[field] === undefined) fail(`manifest.json is missing required field '${field}'.`);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manifest.id ?? "")) {
  fail("manifest.json 'id' must be a GUID, kept stable across versions.");
}
for (const icon of Object.values(manifest.icons ?? {})) {
  if (!existsSync(join(PKG_DIR, icon))) fail(`Icon '${icon}' referenced by the manifest is missing from the package.`);
}

// --- skills -----------------------------------------------------------------
const skills = manifest.agentSkills ?? [];
if (skills.length > 20) fail("ASKILL-M002: at most 20 agentSkills entries are allowed.");
const seenFolders = new Set();

for (const entry of skills) {
  if (!entry.folder) {
    fail("ASKILL-M001: every agentSkills entry needs a 'folder'.");
    continue;
  }
  if (entry.folder.length > 256) fail(`ASKILL-M003: folder path too long: ${entry.folder}`);
  if (seenFolders.has(entry.folder)) fail(`ASKILL-P008: duplicate agentSkills folder '${entry.folder}'.`);
  seenFolders.add(entry.folder);
  checkPackagePath(entry.folder, `agentSkills folder '${entry.folder}'`);

  const folderAbs = join(PKG_DIR, entry.folder);
  if (!existsSync(folderAbs)) {
    fail(`ASKILL-P001: folder '${entry.folder}' is referenced by the manifest but missing from the package.`);
    continue;
  }
  const skillMd = join(folderAbs, "SKILL.md");
  if (!existsSync(skillMd)) {
    fail(`ASKILL-P002: '${entry.folder}' has no SKILL.md.`);
    continue;
  }

  const text = readFileSync(skillMd, "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) {
    fail(`ASKILL-P003: SKILL.md in '${entry.folder}' has no YAML frontmatter between --- delimiters.`);
    continue;
  }
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1].trim();
  const hasDescription = /^description:\s*(\S|\|)/m.test(fm[1]);
  if (!name) fail(`ASKILL-P004: SKILL.md in '${entry.folder}' has no 'name'.`);
  if (!hasDescription) fail(`ASKILL-P005: SKILL.md in '${entry.folder}' has no 'description'.`);

  const folderName = entry.folder.split("/").filter(Boolean).pop();
  if (name && name !== folderName) {
    fail(`ASKILL-P006: SKILL.md name '${name}' does not match folder '${folderName}'.`);
  }
  if (name && !KEBAB.test(name)) fail(`ASKILL-P007: skill name '${name}' is not kebab-case.`);

  const companions = walk(folderAbs).filter((p) => p !== skillMd);
  if (companions.length > MAX_COMPANIONS) {
    fail(`'${entry.folder}' has ${companions.length} companion files; the limit is ${MAX_COMPANIONS}.`);
  }
  let total = 0;
  for (const c of companions) {
    const size = statSync(c).size;
    total += size;
    const rel = relative(folderAbs, c).split(sep).join("/");
    if (size > MAX_COMPANION_BYTES) fail(`Companion file '${rel}' exceeds 5 MB.`);
    for (const segment of rel.split("/")) {
      if (segment.startsWith(".")) fail(`Companion file '${rel}' is a hidden file, which is not allowed.`);
      if (!/^[A-Za-z0-9._ !-]+$/.test(segment)) fail(`Companion file '${rel}' uses unsupported characters.`);
      if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(segment.split(".")[0])) {
        fail(`Companion file '${rel}' uses a Windows reserved name.`);
      }
    }
  }
  if (total > MAX_TOTAL_COMPANION_BYTES) fail(`'${entry.folder}' companion files exceed 10 MB in total.`);
}

// --- connectors -------------------------------------------------------------
const connectors = manifest.agentConnectors ?? [];
if (connectors.length > 10) fail("At most 10 agentConnectors are allowed per package.");
const seenIds = new Set();

for (const c of connectors) {
  if (!c.id) fail("Every agentConnectors entry needs an 'id'.");
  if (!c.displayName) fail(`Connector '${c.id ?? "?"}' needs a 'displayName'.`);
  if (c.id && seenIds.has(c.id)) fail(`Duplicate connector id '${c.id}'.`);
  seenIds.add(c.id);

  const source = c.toolSource ?? {};
  const kinds = ["plugin", "remoteMcpServer"].filter((k) => source[k]);
  if (kinds.length !== 1) fail(`Connector '${c.id}' must declare exactly one of 'plugin' or 'remoteMcpServer'.`);

  const remote = source.remoteMcpServer;
  if (!remote) continue;

  if (!/^https:\/\//i.test(remote.mcpServerUrl ?? "")) {
    fail(`Connector '${c.id}': mcpServerUrl must be an HTTPS URL.`);
  } else if (remote.mcpServerUrl.includes(PLACEHOLDER)) {
    fail(
      `Connector '${c.id}': mcpServerUrl is still the placeholder, so no real URL was resolved.\n` +
        HOW_TO_SET_URL
    );
  } else {
    // Cowork blocks requests to hosts the manifest does not declare, so a
    // mismatch here yields a connector that installs but never responds.
    const host = new URL(remote.mcpServerUrl).host;
    const domains = manifest.validDomains ?? [];
    const covered = domains.some((d) => d === host || (d.startsWith("*.") && host.endsWith(d.slice(1))));
    if (!covered) {
      fail(`Connector '${c.id}': mcpServerUrl host '${host}' is not listed in validDomains (${domains.join(", ") || "empty"}).`);
    }
  }
  const toolFile = remote.mcpToolDescription?.file;
  if (!toolFile) {
    fail(`Connector '${c.id}': mcpToolDescription.file is required, or the upload fails with HTTP 400.`);
  } else if (!checkPackagePath(toolFile, `Connector '${c.id}' mcpToolDescription.file`)) {
    // Path shape already reported; skip the existence check to avoid noise.
  } else if (!existsSync(join(PKG_DIR, toolFile))) {
    fail(`Connector '${c.id}': tool description '${toolFile}' is missing from the package.`);
  } else {
    const tools = JSON.parse(readFileSync(join(PKG_DIR, toolFile), "utf8")).tools ?? [];
    for (const t of tools) {
      if (!t.annotations) {
        fail(`Tool '${t.name}' has no annotations; Cowork treats unannotated tools as destructive.`);
      }
    }
  }

  const auth = remote.authorization;
  if (auth) {
    if (auth.type === "None" && auth.referenceId !== undefined) {
      fail(`Connector '${c.id}': referenceId must not be set when authorization type is 'None'.`);
    }
    if (auth.type !== "None" && !auth.referenceId) {
      fail(`Connector '${c.id}': referenceId is required for authorization type '${auth.type}'.`);
    }
  }
}

if (errors.length) {
  console.error("Package validation failed:\n" + errors.map((e) => "  - " + e).join("\n"));
  process.exit(1);
}

// --- zip --------------------------------------------------------------------
// Everything must sit at the zip root, so we archive the *contents* of
// cowork-plugin/ rather than the folder itself. The archive is written by hand
// (store + deflate entries) to avoid depending on a zip tool being present.
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, data, mtime } of entries) {
    const isDir = name.endsWith("/");
    const body = isDir ? Buffer.alloc(0) : data;
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = isDir ? body : deflateRawSync(body, { level: 9 });
    const useDeflate = !isDir && deflated.length < body.length;
    const payload = useDeflate ? deflated : body;
    const method = useDeflate ? 8 : 0;
    const crc = zlibCrc32(body) >>> 0;

    // MS-DOS timestamp, 2-second resolution.
    const dosTime =
      (mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1);
    const dosDate =
      ((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    // External attributes: mark directory entries with the FAT directory bit so
    // extractors that key off attributes (rather than the trailing slash) agree.
    cd.writeUInt32LE(isDir ? 0x10 : 0x20, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cdBuf, end]);
}

mkdirSync(dirname(OUT_ZIP), { recursive: true });

const files = walk(PKG_DIR)
  .map((p) => posix.join(...relative(PKG_DIR, p).split(sep)))
  .sort();

// Standard zip writers emit an entry for every directory. Include them so the
// archive matches what Compress-Archive / `zip -r` produce, and so consumers
// that enumerate directories see the same tree.
const dirs = [
  ...new Set(
    files.flatMap((f) => {
      const parts = f.split("/").slice(0, -1);
      return parts.map((_, i) => parts.slice(0, i + 1).join("/") + "/");
    })
  ),
].sort();

const entries = [...dirs, ...files].sort().map((name) => {
  const isDir = name.endsWith("/");
  const abs = join(PKG_DIR, isDir ? name.slice(0, -1) : name);
  // manifest.json is emitted from the in-memory object so an MCP_SERVER_URL
  // override lands in the package without touching the working tree.
  const data = isDir
    ? Buffer.alloc(0)
    : name === "manifest.json"
      ? Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8")
      : readFileSync(abs);
  return { name, data, mtime: statSync(abs).mtime };
});

writeFileSync(OUT_ZIP, zip(entries));

console.log("Packaged " + files.length + " files (" + dirs.length + " directory entries):");
for (const f of files) console.log("  " + f);
console.log("\n-> " + OUT_ZIP);
console.log('Sideload with: atk install --file-path "' + OUT_ZIP + '" --scope Personal');
