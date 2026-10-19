import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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
import { ASSET_DECIMALS, coinFor, type Send21Currency } from "../currencies.js";
import { canonicalize, sha256Hex } from "../jcs.js";
import { mcpUpstream, type Upstream } from "../upstream.js";
import { signV2 } from "../verify.js";
import snapshotJson from "./send21-mcp-snapshot.json" with { type: "json" };

// Mock send21 (no key, no network, no money). It is a real MCP server, served
// in memory, with the tool, resource and prompt list of the live server
// (snapshot in send21-mcp-snapshot.json). The guard talks to it through the
// same MCP client it uses for https://send21.io/mcp.
//
// mockWallet.pay() plays the human signing in their wallet: it sends the
// webhooks send21 would send, signed with X-Send21-Signature-V2.

const snapshot = snapshotJson as unknown as {
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  resources: { uri: string; name: string; title?: string; description?: string; mimeType?: string }[];
  prompts: { name: string; title?: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[];
};

const TOKENS: Record<string, string> = {
  "Usdc/Base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "Usdc/Solana": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};
// Mock rates, fiat per whole unit. Not real.
const RATES: Record<string, number> = { Btc: 60000, Usdc: 1, Usdt: 1, Eurc: 1.08, Sol: 150, Eth: 3000 };
const CHAIN_IDS: Record<string, number> = { Ethereum: 1, Base: 8453, Arbitrum: 42161, Polygon: 137 };

interface MockDraft {
  core: Record<string, unknown>;
  coreSha256: string;
  status: "AwaitingPayment" | "Seen" | "Confirmed" | "Expired" | "Cancelled";
  cryptoAmountBaseUnits: number;
  idempotencyKey: string | null;
  args: string;
  paidTxId: string | null;
}

export type Delivery = { event: string; status: number; body: Record<string, unknown> | null };

export interface MockSend21 {
  upstream: Upstream;
  drafts: Map<string, MockDraft>;
  /** Point the mock's webhooks at the guard. */
  setWebhook(url: string, secret: string): void;
  /** Play the human's wallet for one draft. */
  pay(draftId: string, action: "sign" | "short" | "expire" | "wrong-amount"): Promise<Delivery[]>;
  calls: { name: string; args: Record<string, unknown> }[];
  replayLast(): Promise<Delivery>;
}

export function createMockSend21(opts: { now?: () => Date; delayMs?: number } = {}): MockSend21 {
  const now = opts.now ?? (() => new Date());
  const drafts = new Map<string, MockDraft>();
  const calls: MockSend21["calls"] = [];
  let seq = 0;
  let hook: { url: string; secret: string } | null = null;
  const id = (n: number) => `3f6c2a9e-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  const err = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
  const view = (d: MockDraft) => ({ id: d.core.id, status: d.status, core: d.core, coreSha256: d.coreSha256, expiresAt: d.core.expiresAt, mock: true });

  function createDraft(a: Record<string, unknown>): CallToolResult {
    const currency = String(a.currency ?? "Btc") as Send21Currency;
    const network = String(a.network ?? "");
    if (typeof a.receiverAddress !== "string" || !network) return err("receiverAddress and network are required");
    if (!coinFor(currency, network)) return err(`${currency} is not available on ${network}`);
    const exact = typeof a.amountBaseUnits === "number";
    const fiat = typeof a.fiatAmount === "number" && typeof a.fiatCurrency === "string";
    if (exact === fiat) return err("give amountBaseUnits, or fiatCurrency + fiatAmount");
    const key = typeof a.idempotencyKey === "string" ? a.idempotencyKey : null;
    const argsKey = JSON.stringify([a.receiverAddress, network, currency, a.amountBaseUnits ?? null, a.fiatCurrency ?? null, a.fiatAmount ?? null]);
    if (key) {
      const prior = [...drafts.values()].find((d) => d.idempotencyKey === key);
      if (prior) return prior.args === argsKey ? ok(view(prior)) : err("422: Idempotency-Key reused with another receiver, amount, currency or network");
    }
    const created = now();
    const crypto = exact ? (a.amountBaseUnits as number) : Math.round(((a.fiatAmount as number) / RATES[currency]!) * 10 ** ASSET_DECIMALS[currency]);
    const core = {
      amountBaseUnits: exact ? a.amountBaseUnits : null,
      bolt11: null,
      createdAt: created.toISOString(),
      currency,
      expiresAt: new Date(created.getTime() + 24 * 3600_000).toISOString(),
      fiatAmount: fiat ? a.fiatAmount : null,
      fiatCurrency: fiat ? a.fiatCurrency : null,
      id: id(++seq),
      lightningAddress: null,
      memo: typeof a.memo === "string" ? a.memo : null,
      network,
      paymentMethod: "MultiOutput",
      paymentRequestId: null,
      receiverAddress: a.receiverAddress,
      schema: "send21.draft.core.v1",
      shortfallAbsorbPercent: null,
      tokenAddress: TOKENS[`${currency}/${network}`] ?? null,
    };
    const d: MockDraft = { core, coreSha256: sha256Hex(canonicalize(core)), status: "AwaitingPayment", cryptoAmountBaseUnits: crypto, idempotencyKey: key, args: argsKey, paidTxId: null };
    drafts.set(core.id, d);
    return ok(view(d));
  }

  function template(d: MockDraft) {
    const c = d.core;
    const amt = d.cryptoAmountBaseUnits;
    const token = c.tokenAddress as string | null;
    const decimals = ASSET_DECIMALS[c.currency as Send21Currency];
    const whole = (amt / 10 ** decimals).toFixed(decimals);
    const uri =
      c.network === "Solana"
        ? `solana:${c.receiverAddress}?amount=${whole}${token ? `&spl-token=${token}` : ""}`
        : c.network === "Mainnet"
          ? `bitcoin:${c.receiverAddress}?amount=${whole}`
          : token
            ? `ethereum:${token}@${CHAIN_IDS[c.network as string]}/transfer?address=${c.receiverAddress}&uint256=${amt}`
            : `ethereum:${c.receiverAddress}@${CHAIN_IDS[c.network as string]}?value=${amt}e9`;
    return { draftId: c.id, outputs: [{ address: c.receiverAddress, amountBaseUnits: amt }], paymentUri: uri, mock: true };
  }

  async function call(name: string, a: Record<string, unknown>): Promise<CallToolResult> {
    calls.push({ name, args: a });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const d = typeof a.draftId === "string" ? drafts.get(a.draftId) : undefined;
    switch (name) {
      case "create_draft":
        return createDraft(a);
      case "get_draft":
        return d ? ok(view(d)) : err("404: draft not found");
      case "get_draft_status":
        return d ? ok({ id: d.core.id, status: d.status, paidTxId: d.paidTxId, confirmations: d.status === "Confirmed" ? 1 : 0 }) : err("404: draft not found");
      case "get_transaction_template":
        return d ? ok(template(d)) : err("404: draft not found");
      case "get_rate":
        return RATES[String(a.asset)] ? ok({ asset: a.asset, fiatCurrency: a.fiatCurrency, rate: RATES[String(a.asset)], rateSource: "mock" }) : err("unknown asset");
      case "get_fee_schedule":
        return ok({ mock: true, note: "See https://send21.io/pricing for the real schedule" });
      default:
        return snapshot.tools.some((t) => t.name === name) ? err(`mock: ${name} is not simulated`) : err(`unknown tool ${name}`);
    }
  }

  function serve(): Server {
    const server = new Server({ name: "send21 (mock)", version: "mock" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: snapshot.tools as never }));
    server.setRequestHandler(CallToolRequestSchema, (req) => call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: snapshot.resources }));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
      contents: [{ uri: req.params.uri, mimeType: "text/markdown", text: `Mock of ${req.params.uri}. The real resource: connect to https://send21.io/mcp (no key needed for resources).` }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: snapshot.prompts }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
      messages: [{ role: "user", content: { type: "text", text: `(mock ${req.params.name}) Check where ${JSON.stringify(req.params.arguments ?? {})} stands with get_draft_status and explain it in plain words.` } }],
    }));
    return server;
  }

  const upstream = mcpUpstream(() => {
    const [client, server] = InMemoryTransport.createLinkedPair();
    void serve().connect(server);
    return client;
  }, "budget-guard-mock");

  let last: { event: string; raw: string; deliveryId: string } | null = null;
  async function deliver(event: string, data: Record<string, unknown>, again?: { raw: string; deliveryId: string }) {
    if (!hook) throw new Error("mock: no webhook set");
    const raw = again?.raw ?? JSON.stringify({ event, data });
    const deliveryId = again?.deliveryId ?? crypto.randomUUID();
    last = { event, raw, deliveryId };
    const r = await fetch(hook.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-send21-event": event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(now().getTime() / 1000), hook.secret) },
      body: raw,
    });
    return { event, status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  }

  async function pay(draftId: string, action: "sign" | "short" | "expire" | "wrong-amount") {
    const d = drafts.get(draftId);
    if (!d) throw new Error("mock: unknown draft");
    const c = d.core;
    const amt = d.cryptoAmountBaseUnits;
    const decimals = ASSET_DECIMALS[c.currency as Send21Currency];
    const base = {
      draftId,
      sentCurrency: String(c.currency).toUpperCase(),
      network: c.network,
      amountSats: amt,
      sentAmount: (amt / 10 ** decimals).toFixed(decimals),
      ...(c.fiatCurrency ? { fiatCurrency: c.fiatCurrency, fiatAmount: c.fiatAmount } : {}),
      occurredAt: now().toISOString(),
    };
    const txId = `mock${sha256Hex(draftId).slice(0, 40)}`;
    const out = [];
    if (action === "expire") {
      d.status = "Expired";
      out.push(await deliver("draft.expired", { ...base, status: "Expired" }));
    } else if (action === "short") {
      out.push(await deliver("draft.amount_mismatch", { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amt * 0.95) }));
    } else {
      d.status = "Seen";
      out.push(await deliver("draft.seen", { ...base, status: "Seen", txId, confirmations: 0 }));
      d.status = "Confirmed";
      d.paidTxId = txId;
      const amountSats = action === "wrong-amount" ? amt + 1_000_000 : amt;
      out.push(await deliver("draft.confirmed", { ...base, amountSats, status: "Confirmed", txId, confirmations: 1 }));
    }
    return out;
  }

  /** send21 retries reuse the delivery id (llms-full.txt line 376). Resend the last one, freshly signed. */
  const replayLast = async () => {
    if (!last) throw new Error("mock: nothing delivered yet");
    return deliver(last.event, {}, last);
  };

  return { upstream, drafts, calls, pay, replayLast, setWebhook: (url, secret) => void (hook = { url, secret }) };
}
