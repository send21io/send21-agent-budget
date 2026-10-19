import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { BudgetGuard } from "./guard.js";
import type { Upstream } from "./upstream.js";

// The MCP server the agent talks to. It offers two guard tools and a few
// read-only send21 tools. It does NOT offer create_draft,
// create_payment_request or submit_lightning_proof: the only way to ask for
// money is propose_payment, which goes through the budget.

/** Read-only send21 tools passed through (llms-full.txt lines 493-507). Draft tools only for this guard's own drafts. */
export const PASS_THROUGH = ["get_draft_status", "get_draft", "get_transaction_template", "list_draft_quotes", "get_rate", "get_fee_schedule"] as const;
const DRAFT_SCOPED = new Set<string>(["get_draft_status", "get_draft", "get_transaction_template", "list_draft_quotes"]);
/** send21 prompts passed through. create_pay_link and handle_amount_mismatch need tools the agent does not get. */
export const PASS_PROMPTS = ["check_payment"] as const;

const json = (value: unknown, isError = false): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

export function guardTools(guard: BudgetGuard) {
  const p = guard.policy;
  return [
    {
      name: "propose_payment",
      title: "Propose a payment (a human signs it)",
      description:
        `Propose a payment to a named recipient. budget-guard checks the ${p.period}ly budget of ${guard.fmt(p.cap)} (max ${guard.fmt(p.perPaymentMax)} per payment), ` +
        "the allowed recipients and coins, reserves the amount, and creates a send21 draft. A human reviews and signs it in their own wallet: " +
        "you can never pay it yourself and you never get keys. Blocked proposals come back with a reason.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: `Recipient name from budget_status: ${p.recipients.map((r) => r.name).join(", ")}. Never an address.` },
          amount: { type: ["string", "number"], description: `Amount in ${p.unit}, e.g. "4.50"` },
          coin: { type: "string", description: "Optional coin id, e.g. usdc-base. Default: the recipient's first coin" },
          reason: { type: "string", description: "Why, in plain words, max 140 characters, no links. The human reads it before signing" },
          purchaseId: { type: "string", description: "Your id for this purchase (a-z, 0-9, dashes). Retrying with the same id never creates a second payment" },
        },
        required: ["to", "amount", "reason"],
        additionalProperties: false,
      },
    },
    {
      name: "budget_status",
      title: "Budget left",
      description: "Spent (confirmed payments only), reserved (proposals waiting for a signature), left, when it resets, allowed recipients and recent proposals.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

export function createGuardMcpServer(guard: BudgetGuard, upstream: Upstream): Server {
  const server = new Server({ name: "budget-guard", version: "0.1.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: "Agent proposes, human signs. Use budget_status, then propose_payment. Never ask for keys or seed phrases." });
  let passTools: Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]> | null = null;
  const loadPass = () =>
    (passTools ??= upstream
      .listTools()
      .then((tools) => tools.filter((t) => (PASS_THROUGH as readonly string[]).includes(t.name)).map((t) => ({ ...t, description: `(send21, read-only) ${t.description ?? ""}` })))
      .catch((err) => {
        passTools = null;
        throw err;
      }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...guardTools(guard), ...(await loadPass().catch(() => []))] as never }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (name === "propose_payment") {
      const r = await guard.propose(args);
      return json(r, !r.ok);
    }
    if (name === "budget_status") return json(guard.status());
    if (!(PASS_THROUGH as readonly string[]).includes(name)) {
      return json({ error: `${name} is not available through budget-guard. Propose payments with propose_payment; a human signs them.` }, true);
    }
    if (DRAFT_SCOPED.has(name) && !guard.store.proposals().some((p) => p.draftId && p.draftId === args.draftId)) {
      return json({ error: "only drafts this budget-guard created can be read here" }, true);
    }
    const r = await upstream.callTool(name, args).catch((err: Error) => ({ ok: false as const, error: `send21 unreachable: ${err.message}` }));
    return r.ok ? { content: [{ type: "text", text: r.text }] } : json({ error: r.error }, true);
  });

  // Public, read-only send21 resources (docs, currencies, fees, webhooks, brand), passed through as they are.
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: (await upstream.listResources().catch(() => [])) as never }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (!req.params.uri.startsWith("send21://")) throw new Error("unknown resource");
    return (await upstream.readResource(req.params.uri)) as never;
  });
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: (await upstream.listPrompts().catch(() => [])).filter((p) => (PASS_PROMPTS as readonly string[]).includes(p.name)) as never,
  }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (!(PASS_PROMPTS as readonly string[]).includes(req.params.name)) throw new Error("prompt not available through budget-guard");
    return (await upstream.getPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, string>)) as never;
  });
  return server;
}
