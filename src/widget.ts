/**
 * Expense widget logic for the M365 Copilot MCP App.
 *
 * This module uses the official MCP Apps SDK (`@modelcontextprotocol/ext-apps`)
 * to talk to the Copilot host over the sandboxed-iframe postMessage bridge.
 *
 * The critical lifecycle (per the MCP Apps spec):
 *   1. Create the `App` instance.
 *   2. Register handlers (`ontoolresult`, ...) BEFORE connecting.
 *   3. Call `app.connect()` — this performs the `ui/initialize` handshake that
 *      tells the host the iframe is ready. WITHOUT this, the host shows a
 *      perpetual loading spinner and never delivers the tool result.
 *
 * Host bridge mapping (do NOT use `window.openai.*` or invented `window.app.*`):
 *   - tool result data  -> `app.ontoolresult` (structuredContent / content)
 *   - call a server tool -> `app.callServerTool({ name, arguments })`
 *   - host theme         -> `app.getHostContext()?.theme`
 *
 * Only `resources/read`, `tools/call` and `ui/message` are proxied by the host.
 * Do NOT rely on `openLink` (`ui/open-link`), `ui/update-model-context`, or the
 * `pip` display mode — Copilot Cowork rejects all three.
 *
 * The widget also keeps a standalone-preview fallback so the built HTML still
 * renders when opened directly in a browser (no host present).
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Expense {
  id: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
}

interface ExpenseToolData {
  mode?: string;
  prefill?: Partial<Omit<Expense, "id">>;
  expense?: Expense;
  summary?: string;
  recent?: Expense[];
  currency?: string;
}

// --- DOM helpers -------------------------------------------------------------
function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function esc(value: unknown): string {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => {
    return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c];
  });
}

function fmtAmount(amount: unknown, currency: string | undefined): string {
  const n = Number(amount) || 0;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "EUR" }).format(n);
  } catch {
    return n.toFixed(2) + " " + (currency || "EUR");
  }
}

function renderRecent(list: Expense[] | undefined): void {
  const container = el("recentList");
  if (!list || !list.length) {
    container.innerHTML = '<p class="empty">No expenses yet.</p>';
    return;
  }
  container.innerHTML = list
    .map((x) => {
      return (
        '<div class="item">' +
        "<div><div>" +
        esc(x.merchant) +
        "</div>" +
        '<div class="meta">' +
        esc(x.category) +
        " &middot; " +
        esc(x.date) +
        "</div></div>" +
        '<div class="amt">' +
        esc(fmtAmount(x.amount, x.currency)) +
        "</div>" +
        "</div>"
      );
    })
    .join("");
}

function showError(msg: string): void {
  const box = el("errBox");
  box.textContent = msg;
  box.classList.remove("hidden");
}

function showSuccess(data: ExpenseToolData, fallbackSummary?: string): void {
  const exp = data.expense || ({} as Expense);
  const id = exp.id || "(pending)";
  const summary = data.summary || fallbackSummary || "";
  el("successId").textContent = id;
  el("successSummary").textContent = summary;
  el("successBox").classList.remove("hidden");
}

// --- Tool result parsing -----------------------------------------------------
// The host delivers the tool result via `ontoolresult`. Prefer structuredContent
// (the data + widget contract); fall back to parsing the first text content block.
function parseToolResult(params: {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
}): ExpenseToolData | null {
  if (params.structuredContent && typeof params.structuredContent === "object") {
    return params.structuredContent as ExpenseToolData;
  }
  const textBlock = params.content?.find((c) => c.type === "text" && c.text);
  if (textBlock?.text) {
    try {
      return JSON.parse(textBlock.text) as ExpenseToolData;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

// --- Shared state ------------------------------------------------------------
let recent: Expense[] = [];

// Populate the form with whatever the user already mentioned in chat. Only
// fields actually supplied are touched, so the widget's own defaults (today's
// date, EUR) survive. Unknown category values are ignored rather than forcing
// the <select> into an invalid state.
function applyPrefill(prefill: Partial<Omit<Expense, "id">> | undefined): void {
  if (!prefill) return;

  if (prefill.merchant) el<HTMLInputElement>("merchant").value = String(prefill.merchant);
  if (typeof prefill.amount === "number" && prefill.amount > 0) {
    el<HTMLInputElement>("amount").value = String(prefill.amount);
  }
  if (prefill.date) el<HTMLInputElement>("date").value = String(prefill.date);

  for (const [id, value] of [
    ["currency", prefill.currency],
    ["category", prefill.category],
  ] as const) {
    if (!value) continue;
    const select = el<HTMLSelectElement>(id);
    if (select && Array.from(select.options).some((o) => o.value === value)) {
      select.value = String(value);
    }
  }

  // Send focus to the first field still empty, so the user lands on what is
  // actually left to type rather than at the top of a mostly-filled form.
  const firstEmpty = ["merchant", "amount", "date"]
    .map((id) => el<HTMLInputElement>(id))
    .find((input) => input && !input.value);
  firstEmpty?.focus();
}

function applyData(data: ExpenseToolData | null): void {
  if (!data) return;
  if (Array.isArray(data.recent)) {
    recent = data.recent.slice();
    renderRecent(recent);
  }
  if (data.currency) {
    const cur = el<HTMLSelectElement>("currency");
    if (cur) cur.value = data.currency;
  }
  applyPrefill(data.prefill);
  // Only a completed submission carries an expense; opening the form must not
  // show a success box for something that has not been recorded yet.
  if (data.expense) {
    showSuccess(data);
  }
}

// --- Theme -------------------------------------------------------------------
function applyTheme(theme: string | undefined): void {
  if (theme === "light" || theme === "dark") {
    document.documentElement.dataset.theme = theme;
  }
}

// --- Boot --------------------------------------------------------------------
const runningInHost = window.self !== window.top;
let app: App | null = null;

function wireForm(submit: (args: Record<string, unknown>) => Promise<ExpenseToolData | null>): void {
  const dateInput = el<HTMLInputElement>("date");
  dateInput.value = new Date().toISOString().slice(0, 10);
  renderRecent(recent);

  el<HTMLFormElement>("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    el("errBox").classList.add("hidden");

    const args = {
      merchant: el<HTMLInputElement>("merchant").value.trim(),
      amount: Number(el<HTMLInputElement>("amount").value),
      currency: el<HTMLSelectElement>("currency").value,
      category: el<HTMLSelectElement>("category").value,
      date: el<HTMLInputElement>("date").value,
    };

    if (!args.merchant || !(args.amount > 0)) {
      showError("Enter a merchant and an amount greater than zero.");
      return;
    }

    const btn = el<HTMLButtonElement>("submitBtn");
    btn.disabled = true;
    btn.textContent = "Submitting...";

    try {
      const data = await submit(args);
      if (data) {
        if (Array.isArray(data.recent)) {
          recent = data.recent.slice();
          renderRecent(recent);
        }
        showSuccess(data, args.merchant + " " + fmtAmount(args.amount, args.currency));
      }
      el<HTMLFormElement>("form").reset();
      dateInput.value = new Date().toISOString().slice(0, 10);
    } catch (e) {
      showError("Could not submit expense: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      btn.disabled = false;
      btn.textContent = "Submit expense";
    }
  });
}

async function boot(): Promise<void> {
  if (!runningInHost) {
    // Standalone browser preview: no MCP host. Simulate the server locally so
    // the form + list still work for quick testing / stage demos.
    wireForm(async (args) => {
      const localId = "exp_" + Math.random().toString(36).slice(2, 8);
      const expense: Expense = {
        id: localId,
        merchant: String(args.merchant),
        amount: Number(args.amount),
        currency: String(args.currency),
        category: String(args.category),
        date: String(args.date),
      };
      recent.unshift(expense);
      return {
        expense,
        summary: expense.merchant + " " + fmtAmount(expense.amount, expense.currency),
        recent,
      };
    });
    return;
  }

  // Running inside the Copilot host (sandboxed iframe).
  app = new App({ name: "expense-mcp-app", version: "1.0.0" }, {});

  // Register handlers BEFORE connect so no notifications are missed.
  app.ontoolresult = (params) => {
    applyData(parseToolResult(params as Parameters<typeof parseToolResult>[0]));
  };
  app.onhostcontextchanged = (ctx) => {
    applyTheme(ctx.theme as string | undefined);
  };

  wireForm(async (args) => {
    const result = await app!.callServerTool({ name: "submitExpense", arguments: args });
    if (result.isError) {
      const text = (result.content as Array<{ type: string; text?: string }> | undefined)?.find(
        (c) => c.type === "text" && c.text,
      );
      throw new Error(text?.text || "The server reported an error.");
    }
    return parseToolResult(result as Parameters<typeof parseToolResult>[0]);
  });

  // Complete the handshake — this is what makes the widget actually appear.
  await app.connect();
  applyTheme(app.getHostContext()?.theme as string | undefined);
}

void boot();
