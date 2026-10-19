import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentApp } from "../src/http.js";
import { parseToolResult } from "../src/upstream.js";
import { listen, setup } from "./helpers.js";

const AGENT = "agent-token-agent-token-agent-token";
const ADMIN = "admin-token-admin-token-admin-token";
let ctx: ReturnType<typeof setup>;
let server: Awaited<ReturnType<typeof listen>>;
let client: Client;

beforeEach(async () => {
  ctx = setup();
  server = await listen(createAgentApp({ guard: ctx.guard, upstream: ctx.mock.upstream, agentToken: AGENT, adminToken: ADMIN }));
  client = new Client({ name: "test-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${AGENT}` } } }));
});
afterEach(async () => {
  await client.close();
  await server.close();
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, ...parseToolResult(r) };
};

describe("budget-guard MCP server", () => {
  it("offers propose_payment, budget_status and read-only send21 tools, never the spending ones", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["propose_payment", "budget_status", "get_draft_status", "get_draft", "get_transaction_template", "list_draft_quotes", "get_rate", "get_fee_schedule"]));
    for (const hidden of ["create_draft", "create_payment_request", "submit_lightning_proof", "list_address_book", "get_payment_request"]) expect(names).not.toContain(hidden);
    expect((await call("create_draft", { receiverAddress: "0x8617E340B3D01FA5F11F306F4090FD50E238070D", network: "Base", amountBaseUnits: 1 })).isError).toBe(true);
    expect(ctx.mock.calls.filter((c) => c.name === "create_draft")).toHaveLength(0);
  });

  it("proposes through the guard and reads only its own drafts", async () => {
    const r = await call("propose_payment", { to: "api-credits", amount: "12", reason: "credits" });
    expect(r.isError).toBe(false);
    const draftId = (r as { data: { proposal: { draftId: string } } }).data.proposal.draftId;
    expect((await call("get_draft_status", { draftId })).data).toMatchObject({ status: "AwaitingPayment" });
    expect((await call("get_transaction_template", { draftId })).data).toMatchObject({ paymentUri: expect.stringMatching(/^ethereum:0x833589/) });
    expect((await call("get_draft", { draftId: "3f6c2a9e-0000-4000-8000-999999999999" })).isError).toBe(true);
    const blocked = await call("propose_payment", { to: "domains", amount: "9", reason: "domain" });
    expect(blocked).toMatchObject({ isError: true, data: { blocked: "over_budget" } });
    expect((await call("budget_status")).data).toMatchObject({ budget: { reserved: "12.00 USDC", left: "8.00 USDC" } });
  });

  it("passes send21's public resources and the check_payment prompt through", async () => {
    const uris = (await client.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["send21://docs/overview", "send21://docs/currencies", "send21://fees/schedule", "send21://docs/webhooks", "send21://brand/guidelines"]));
    expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual(["check_payment"]);
    await expect(client.getPrompt({ name: "create_pay_link", arguments: {} })).rejects.toThrow();
  });

  it("needs the agent token; the admin API needs the other token", async () => {
    const r = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(r.status).toBe(401);
    expect((await fetch(`${server.url}/mcp`, { headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(405);
    expect((await fetch(`${server.url}/admin/status`, { headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(401);
    const p = await call("propose_payment", { to: "domains", amount: "5", reason: "domain" });
    const id = (p as { data: { proposal: { id: string } } }).data.proposal.id;
    const d = await fetch(`${server.url}/admin/proposals/${id}/decline`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    expect(await d.json()).toMatchObject({ ok: true, proposal: { status: "declined" } });
    expect(ctx.guard.usage().minor.reserved).toBe(0);
  });

  it("refuses to start with the same token for agent and admin", () => {
    expect(() => createAgentApp({ guard: ctx.guard, upstream: ctx.mock.upstream, agentToken: AGENT, adminToken: AGENT })).toThrow();
  });
});
