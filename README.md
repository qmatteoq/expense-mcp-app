# Expense MCP App — M365 Copilot demo

A **minimal, anonymous** MCP app that renders an interactive **expense-submission widget**
inside Microsoft 365 Copilot via a **declarative agent**, and inside **Copilot Cowork** via a
**plugin package**. One tool, one widget, mock in-memory data. Built for Matteo Pagani's
BeConnected talk *"MCP in the M365 Copilot ecosystem."*

- **Transport:** Remote MCP server over **Streamable HTTP** (SSE is deprecated).
- **SDK:** Official MCP TypeScript SDK (`@modelcontextprotocol/sdk`) on Node.js + Express.
- **Tool:** `submitExpense` returns `structuredContent` **and** references a UI widget via
  `_meta.ui.resourceUri`. Plus a read-only `listExpenses`.
- **Widget:** single-file HTML/CSS/JS served as `text/html;profile=mcp-app`, Fluent-2 styled.
- **Auth:** **Anonymous (development only).**

**Two ways to consume it** — the same running server, two different packaging paths:

| Host | Packaging | Section |
| --- | --- | --- |
| **Microsoft 365 Copilot** | Declarative agent + MCP action, via Agents Toolkit | [§4](#4-use-it-with-a-declarative-agent-microsoft-365-copilot) |
| **Copilot Cowork** | Plugin `.zip`: connector + Agent Skill | [§7](#7-use-it-with-copilot-cowork) |

---

## 1. Prerequisites

- **Node.js 18+** (tested on 22).
- **VS Code**.
- **Microsoft 365 Agents Toolkit 6.6.1+** (VS Code extension) — for the declarative-agent path.
- **`@microsoft/m365agentstoolkit-cli`** (`atk`) — for sideloading the Cowork plugin.
- A Microsoft 365 tenant with a Microsoft 365 Copilot license and, optionally, Copilot Credits assigned to the user if you want to ues Cowork
- A way to expose `localhost` over HTTPS — a **dev tunnel** (built into VS Code / `devtunnel` CLI)
---
## 2. Build & run locally

```powershell
npm install
npm run build
npm start
```

You should see:

```
expense-mcp-app (anonymous) listening on http://localhost:3000/mcp
health check:                      http://localhost:3000/health
```

- MCP endpoint: **`http://localhost:3000/mcp`** (POST, Streamable HTTP)
- Health check: `http://localhost:3000/health`
- Change the port with the `PORT` env var, e.g. `setx PORT 3030`.

> Quick sanity check: `Invoke-RestMethod http://localhost:3000/health` → `{ status: "ok" }`.

To preview the widget with no host at all, open `dist/widget.html` in a browser — it
detects that no host is present and simulates the server locally.

## 3. Expose the local server (dev tunnel)

Both hosts must reach your server over **public HTTPS**. Either:

**Option A — devtunnel CLI (persistent, recommended)**

A *named* tunnel keeps the same URL across restarts, so you don't have to re-edit the
manifest every time:

```powershell
devtunnel create expense-mcp -a --description "Expense MCP app"
devtunnel port create expense-mcp -p 3000 --protocol http
devtunnel host expense-mcp
```

Reuse it later with just `devtunnel host expense-mcp`. The public URL follows the pattern
`https://<id>-3000.<region>.devtunnels.ms`; your MCP endpoint is that plus `/mcp`.

**Option B — one-shot tunnel**
```powershell
devtunnel user login
devtunnel host -p 3000 --allow-anonymous
```
Copy the public HTTPS URL it prints and append `/mcp`.

**Option C — Agents Toolkit tunnel**
The Toolkit can start/manage a tunnel for you during provisioning; use the URL it surfaces.

> **Use `--protocol http`, not `https`.** The flag describes the **local** service the tunnel
> forwards to, not the public URL. The relay terminates TLS and serves HTTPS either way.
> Setting `https` against a plain-HTTP server makes every tunneled request return `502`.

Dev tunnels expire after **30 days**. Keep `npm start` running while you do the steps below.

---

## 4. Use it with a declarative agent (Microsoft 365 Copilot)

In VS Code with the **Microsoft 365 Agents Toolkit**:

1. **Create New Agent** → **Declarative Agent**.
2. **Add Action** → **Start with an MCP Server**.
3. **Enter the MCP server URL**: your public tunnel URL ending in `/mcp`
   (e.g. `https://<id>-3000.<region>.devtunnels.ms/mcp`).
4. Run **ATK: Fetch action from MCP** — the Toolkit introspects the server.
5. **Select the `submitExpense` tool** (it has an associated widget via `_meta.ui.resourceUri`). Add `listExpenses` too if you want the read-only path.
6. **Choose authentication: Anonymous.**
7. **Provision** the agent (uploads the declarative agent + action package to your tenant).
8. **Test** at **https://m365.cloud.microsoft/chat** — open your agent and ask it to submit an
   expense (e.g. *"Submit a 42 EUR meal at Trattoria Roma today"*). The inline widget renders.

**Iterating:** changes to the tool logic or the widget need only `npm run build` + a server
restart — the host reads both live. Re-provision only when the *action* itself changes
(new tools, renamed tools, changed input schemas), since that is what the uploaded package
describes.

If ATK reports that the server exposes **no tools**, see [§6](#6-troubleshooting-atk-shows-no-tools).

## 5. What to show on stage

1. Open the agent in **https://m365.cloud.microsoft/chat** and trigger `submitExpense`.
2. The **inline widget** renders right in the conversation: a Fluent-2 expense form (merchant, amount, currency, category, date) plus a **Recent expenses** list seeded with two rows.
3. Fill the form and click **Submit expense** — the widget calls the server tool through the host bridge and flips to a **success state** showing the returned **expense id** and summary.
4. The new expense appears at the top of **Recent expenses** (served from `structuredContent`).
5. Point out: the widget **feature-detects** the host API and falls back gracefully, so the very same file also previews standalone in a browser.
6. Then show the **same server** running inside **Cowork** as a plugin ([§7](#7-use-it-with-copilot-cowork)) — one MCP server, two hosts, no code change.

## 6. Troubleshooting: ATK shows no tools

If **ATK: Fetch action from MCP** reports that the server exposes **no tools**
(so you cannot turn them into a declarative-agent action), the server is almost
certainly using a **stateless, per-request** Streamable HTTP transport.

**Why it breaks:** ATK introspects the server with **separate** JSON-RPC calls —
first an `initialize`, then a `tools/list`. The MCP lifecycle requires that the
`initialize` response issue an **`Mcp-Session-Id`** header, and that every later
request reuse it. A stateless server that creates a fresh, un-initialized
`McpServer` per POST (and never issues a session id) rejects the follow-up
`tools/list`, so enumeration returns nothing.

**The fix:** use the canonical **stateful session-management** pattern from the
MCP TypeScript SDK (already implemented in `src/server.ts`):

- `initialize` creates a `StreamableHTTPServerTransport` with a `sessionIdGenerator`, which emits an `Mcp-Session-Id`.
- The transport is cached by session id; subsequent requests (`tools/list`, `tools/call`, the SSE stream on `GET`, termination on `DELETE`) look it up via the `mcp-session-id` header.

**Verify the fix:**

1. Press **Start** on the server in **`.vscode/mcp.json`** (or `npm start`).
2. Run **ATK: Fetch action from MCP** — the \*\*`submitExpense`\*\* and **`listExpenses`** tools should now appear.

If it still fails, enable Copilot debug logs with **`-developer on`** to inspect
the raw `initialize` / `tools/list` exchange and confirm a session id is issued.

## 7. Use it with Copilot Cowork

Cowork is extended with **M365 app packages**, the same distribution mechanism as Teams
apps and Copilot agents. A package can carry two kinds of things:

- **Connectors** — remote MCP servers that give Cowork new tools (this project's server).
- **Skills** — `SKILL.md` files that teach Cowork *when and how* to use those tools.

This repo builds both into `dist/cowork-plugin.zip`. See
[Build plugins for Copilot Cowork](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development).

### Package layout

```
cowork-plugin/                     # sources, zipped with contents at the ROOT
  manifest.json                    # M365 Unified App Manifest v1.28
  color.png                        # 192x192, generated by scripts/build-icons.mjs
  outline.png                      # 32x32, generated by scripts/build-icons.mjs
  tools/
    contoso-expense-tools.json     # mcpToolDescription target (REQUIRED for connectors)
  skills/
    expense-submission/
      SKILL.md                     # workflow: receipt -> submitExpense
      references/
        expense-categories.md      # loaded on demand, keeps SKILL.md lean
dist/cowork-plugin.zip             # the uploadable package
```

The **skill** is what makes the plugin feel native rather than just a bag of tools: it tells
Cowork how to map a receipt onto the five categories, how to normalise amounts and dates,
when to split a hotel folio into separate line items, and never to invent a value it cannot
find. The **connector** supplies the tools the skill calls.

### Step 1 — Point the manifest at your tunnel

The committed manifest ships a **placeholder** host, so the repo carries nobody's personal
tunnel. Replace it before packaging, either way:

**Option A — edit the manifest.** In `cowork-plugin/manifest.json`, set `mcpServerUrl` to
your tunnel URL plus `/mcp`, and put the same host in `validDomains`:

```json
"validDomains": ["<id>-3000.<region>.devtunnels.ms"],
...
"remoteMcpServer": {
  "mcpServerUrl": "https://<id>-3000.<region>.devtunnels.ms/mcp",
  "mcpToolDescription": { "file": "tools/contoso-expense-tools.json" },
  "authorization": { "type": "None" }
}
```

**Option B — pass it at build time** and leave the tracked file untouched (handy when your
tunnel changes, or to keep `git status` clean):

```powershell
$env:MCP_SERVER_URL = "https://<id>-3000.<region>.devtunnels.ms/mcp"
npm run package:plugin
npm run check:connector
```

`MCP_SERVER_URL` rewrites `mcpServerUrl` **and** `validDomains` in the manifest copy written
into the zip. The file on disk is never modified.

> Both hosts must agree. Cowork blocks requests to hosts the manifest does not declare, so a
> `validDomains` mismatch produces a connector that installs cleanly and then never responds.
> The packager checks this for you.

> **Do not write `./tools/...`.** The package service compares the declared path against zip
> entry names *literally*, and those names carry no `./` prefix — so a leading `./` fails the
> upload with `400 InvalidAgentConnector: ... not found in the app package`, even though the
> official docs write it that way. Use the bare form (`tools/contoso-expense-tools.json`),
> which matches either way. `npm run package:plugin` rejects the `./` spelling for you.

### Step 2 — Build the package

```powershell
npm run package:plugin
```

This generates the icons, validates the package, and writes `dist/cowork-plugin.zip`.
Validation fails the build on the mistakes the platform rejects at upload time — you find
out in a second rather than after a round trip:

- a leading `./` on any package path
- a missing `mcpToolDescription`, or one pointing at a file not in the zip (HTTP 400)
- a `SKILL.md` `name` that does not match its folder (ASKILL-P006)
- a name that is not kebab-case (ASKILL-P007)
- a non-HTTPS `mcpServerUrl`, an unreplaced placeholder, or a host missing from `validDomains`
- `referenceId` misuse for the declared authorization type
- companion-file count and size limits
- tools declared without MCP annotations

### Step 3 — Verify the connector is reachable

```powershell
npm run check:connector
```

This runs `initialize` → `notifications/initialized` → `tools/list` against the exact
`mcpServerUrl` in the manifest (or `MCP_SERVER_URL`, if set), asserts every tool declared in
`tools/contoso-expense-tools.json` is really served with matching annotations, and verifies
the MCP apps widget contract (see [§8](#8-mcp-apps-widget-conformance-in-cowork)).

Run it before every upload — a dead tunnel is the most common reason a plugin installs
successfully and then does nothing.

### Step 4 — Install it

Sideload for yourself:

```powershell
npm install -g @microsoft/m365agentstoolkit-cli
atk auth login
atk install --file-path ".\dist\cowork-plugin.zip" --scope Personal
```

A successful install prints a `TitleId` and `AppId` — keep them for later updates or
uninstall.

Or roll out to the whole tenant: **M365 admin center** → **Manage apps** →
**Upload custom app**, then **…** → **Add agent**.

Either way, the plugin then appears under **Cowork** → **Sources & Skills** → **Plugins**.

### Step 5 — Try it

> *"Submit a 42 EUR meal at Trattoria Roma today"*

The skill triggers, Cowork calls `submitExpense`, and the widget mounts inline showing the
new expense id and the recent-expenses list. Fill the form and click **Submit expense** —
that call goes from the widget straight back to your server.

Also worth demoing:

- *"What expenses have I submitted?"* → `listExpenses`, runs with no confirmation prompt
  because it is annotated `readOnlyHint: true`.
- *"Expense this receipt"* with a receipt attached → the skill reads it and fills the fields.

### Iterating

Server-side changes (tool logic, widget HTML) need **no re-upload** — Cowork reads them
live from your server:

```powershell
npm run build
npm start
```

Re-package and re-install only when the **package** changes: the manifest, the skill, or the
tool-description JSON. A new tunnel URL counts as a manifest change.

### Moving to production

- **Replace the placeholder icons.** `scripts/build-icons.mjs` draws a generic receipt glyph.
- **Replace the `None` authorization.** Anonymous access is fine for a dev tunnel, not for a store submission. Switch to `OAuthPluginVault` with a `referenceId` from the OAuth registration in the [Teams Developer Portal](https://dev.teams.microsoft.com/)
  When registering the OAuth client, set usage to **Any Microsoft 365 Organization** so the
 plugin works across tenants.
- **Update the `developer` URLs and the `id` GUID** in `manifest.json`. Keep the GUID stable across versions.
- **The widget DOES render in Cowork.** Cowork implements the MCP Apps extension
  (SEP-1865) and mounts the `ui://` widget in a sandboxed iframe. See
  [MCP apps plugin author guide for Cowork](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/mcp-apps-support)
  and the conformance notes in section 8 below.

## 8. MCP apps (widget) conformance in Cowork

Cowork renders the widget inline via the
[MCP Apps extension (SEP-1865)](https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/mcp-apps-support).
`npm run check:connector` verifies this contract against the live server, since these
rules live in the server's runtime responses rather than in the `.zip`.

| Guideline | Status |
| --- | --- |
| Tool declares `_meta.ui.resourceUri` with a `ui://` URI (≤ 1024 chars) | `ui://widget/expense-form.html` |
| Tool handler returns data, not HTML | Returns `content` + `structuredContent` |
| Resource serves HTML as `text` with `text/html;profile=mcp-app` | Yes — `text`, not a base64 `blob` |
| Inline tool result under 64 KiB | ~415 bytes; `recent` is capped at 50 rows |
| `visibility` includes `"app"` for widget-initiated calls | `["model", "app"]` |
| Self-contained HTML (no external assets) | Widget + SDK inlined by `build-widget.mjs` |
| Graceful degradation when no widget renders | Every result carries a text summary |
| Avoids unsupported `ui/open-link`, `ui/update-model-context`, `pip` | None are used |

---

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Bundles the widget into `dist/widget.html`, then compiles TypeScript |
| `npm start` | Runs the MCP server from `dist/` |
| `npm run build:widget` | Rebuilds only the widget bundle |
| `npm run build:icons` | Regenerates the Cowork package icons |
| `npm run package:plugin` | Validates and zips the Cowork plugin → `dist/cowork-plugin.zip` |
| `npm run check:connector` | Live conformance check against the manifest's `mcpServerUrl` |

`package:plugin` and `check:connector` both honour the `MCP_SERVER_URL` environment
variable, which overrides the manifest's `mcpServerUrl` and `validDomains` without editing
the tracked file. See [§7 Step 1](#step-1--point-the-manifest-at-your-tunnel).

---

## Project layout

```
expense-mcp-app/
  package.json        # scripts: build, package:plugin, check:connector, start
  tsconfig.json       # ES2022, NodeNext, strict, outDir dist
  src/
    server.ts         # MCP server: Streamable HTTP, submitExpense + listExpenses, widget resource
    widget.ts         # widget logic against the MCP Apps SDK
    widget.html       # single-file inline widget (HTML + CSS + JS), served as the UI resource
  scripts/
    build-widget.mjs      # bundles the widget into dist/
    build-icons.mjs       # generates the package icons (placeholders)
    package-plugin.mjs    # validates + zips the Cowork plugin package
    check-connector.mjs   # live tools/list smoke test against the manifest URL
  cowork-plugin/      # Cowork plugin sources (manifest, icons, tools, skills)
  dist/               # build output: server, widget, cowork-plugin.zip
```
