/**
 * Minimal, anonymous MCP "app" for the M365 Copilot ecosystem.
 *
 * - Remote MCP server over Streamable HTTP (SSE is deprecated).
 * - One tool, `submitExpense`, that returns structured content AND references
 *   an interactive UI widget via `_meta.ui.resourceUri`.
 * - One UI resource (the widget) served as `text/html;profile=mcp-app`.
 * - A trivial read-only `listExpenses` tool.
 * - In-memory store, NO authentication (development only).
 *
 * Uses the canonical STATEFUL session-management pattern from the MCP
 * TypeScript SDK: the `initialize` request issues an `Mcp-Session-Id`, and
 * subsequent requests (including ATK's separate `tools/list`) reuse it. A
 * stateless per-request server breaks ATK enumeration, so we keep one
 * transport+server per session, looked up by the `mcp-session-id` header.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- UI widget resource ------------------------------------------------------
// The widget is a single self-contained HTML file (inline CSS + JS, no external
// assets). We read it once at startup and serve its contents as the UI resource.
// `widget.html` lives next to this file in src/ and is copied to dist/ at build.
const WIDGET_URI = "ui://widget/expense-form.html";
const WIDGET_MIME = "text/html;profile=mcp-app";

// `_meta.ui` attached to every widget-enabled tool.
//
// `visibility` MUST include "app" as well as "model". The widget's Submit
// button calls `submitExpense` back through the host via `callServerTool`, and
// hosts enforce visibility at call time: a tool whose declared visibility
// excludes "app" is refused when a widget invokes it. Declaring only ["model"]
// leaves the tool visible to the agent but makes the widget's own submit fail.
// (Omitting `visibility` entirely defaults to both, but being explicit
// documents the intent.)
const UI_META = {
  ui: { resourceUri: WIDGET_URI, visibility: ["model", "app"] },
} as const;
// `build` is just `tsc`, which does not copy widget.html. Resolve it from the
// dist sibling if present, otherwise fall back to the src copy.
function loadWidgetHtml(): string {
  const candidates = [
    join(__dirname, "widget.html"),
    join(__dirname, "..", "src", "widget.html"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error("widget.html not found in: " + candidates.join(", "));
}
const WIDGET_HTML = loadWidgetHtml();

// --- In-memory store ---------------------------------------------------------
interface Expense {
  id: string;
  merchant: string;
  amount: number;
  currency: string;
  category: string;
  date: string;
}

const expenses: Expense[] = [
  // A couple of seed rows so the "recent expenses" list is never empty on stage.
  { id: "exp_seed01", merchant: "Lufthansa", amount: 312.4, currency: "EUR", category: "Travel", date: "2025-05-02" },
  { id: "exp_seed02", merchant: "Hotel Adlon", amount: 189.0, currency: "EUR", category: "Lodging", date: "2025-05-03" },
];

let nextId = 100;
function newExpenseId(): string {
  return "exp_" + (nextId++).toString(36).padStart(4, "0");
}

const CATEGORIES = ["Travel", "Meals", "Lodging", "Supplies", "Other"] as const;

function recentExpenses(limit = 5): Expense[] {
  return expenses.slice(-limit).reverse();
}

// --- MCP server factory ------------------------------------------------------
// One server instance is created per session (stateful Streamable HTTP). The
// `expenses` store above is module-level, so data persists across requests and
// sessions.
function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "expense-mcp-app", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } }
  );

  // Register the widget as a UI resource.
  server.registerResource(
    "expense-form-widget",
    WIDGET_URI,
    {
      title: "Expense submission form",
      description: "Interactive widget to submit and review expenses.",
      mimeType: WIDGET_MIME,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: WIDGET_MIME,
          text: WIDGET_HTML,
        },
      ],
    })
  );

  // Primary tool: submit an expense. Returns structured content and points the
  // host at the widget via `_meta.ui.resourceUri`.
  server.registerTool(
    "submitExpense",
    {
      title: "Submit expense",
      description:
        "Submit a business expense (merchant, amount, currency, category, date) and return a confirmation with the created expense id.",
      // Copilot Cowork reads these to decide whether to prompt for confirmation.
      // Tools with no annotations are treated as destructive.
      annotations: {
        title: "Submit Expense",
        readOnlyHint: false,
        destructiveHint: false,
      },
      inputSchema: {
        merchant: z.string().min(1).describe("Merchant or vendor name"),
        amount: z.number().positive().describe("Expense amount"),
        currency: z.string().default("EUR").describe("ISO currency code, default EUR"),
        category: z.enum(CATEGORIES).describe("Expense category"),
        date: z.string().describe("Expense date, e.g. 2025-05-04"),
      },
      _meta: {
        // Tells the host which UI resource renders this tool's result. Also
        // keeps the tool callable by both the model and the widget itself.
        ...UI_META,
      },
    },
    async ({ merchant, amount, currency, category, date }) => {
      const expense: Expense = {
        id: newExpenseId(),
        merchant,
        amount,
        currency: currency || "EUR",
        category,
        date,
      };
      expenses.push(expense);

      const summary = `${expense.merchant} - ${expense.amount.toFixed(2)} ${expense.currency} (${expense.category})`;

      return {
        content: [{ type: "text", text: `Expense ${expense.id} submitted: ${summary}` }],
        structuredContent: {
          expense,
          summary,
          recent: recentExpenses(),
        },
        _meta: { ...UI_META },
      };
    }
  );

  // Read-only helper tool: list recent expenses.
  server.registerTool(
    "listExpenses",
    {
      title: "List expenses",
      description: "Return the most recent expenses.",
      annotations: {
        title: "List Expenses",
        readOnlyHint: true,
        destructiveHint: false,
      },
      inputSchema: {
        limit: z.number().int().positive().max(50).default(5).describe("Max rows to return"),
      },
      _meta: { ...UI_META },
    },
    async ({ limit }) => {
      const recent = recentExpenses(limit);
      return {
        content: [{ type: "text", text: `${recent.length} recent expense(s).` }],
        structuredContent: { recent },
        _meta: { ...UI_META },
      };
    }
  );

  return server;
}

// --- HTTP transport (Express) ------------------------------------------------
const app = express();
app.use(express.json());

// Stateful session management: keep one transport per session id. The
// `initialize` request creates the session (and emits an `Mcp-Session-Id`);
// every later request reuses it via the `mcp-session-id` header.
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check for quick "is it up?" verification.
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "expense-mcp-app" });
});

// Streamable HTTP MCP endpoint (POST). Anonymous — no auth middleware by
// design (dev only).
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse the transport for an existing session.
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request: create a fresh transport + server and let
      // the SDK issue an `Mcp-Session-Id`.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport;
        },
      });

      // Clean up the session map when the transport closes.
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
    } else {
      // No valid session id and not an initialize request.
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Reusable handler for GET (SSE notification stream) and DELETE (session
// termination). Both look up the transport by the `mcp-session-id` header.
const handleSessionRequest = async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: No valid session ID provided" },
      id: null,
    });
    return;
  }
  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
};

// GET opens the server-to-client SSE notification stream for a session.
app.get("/mcp", handleSessionRequest);
// DELETE terminates a session.
app.delete("/mcp", handleSessionRequest);

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`expense-mcp-app (anonymous) listening on http://localhost:${PORT}/mcp`);
  console.log(`health check:                      http://localhost:${PORT}/health`);
});
