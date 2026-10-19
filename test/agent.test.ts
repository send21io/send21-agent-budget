import { describe, expect, it } from "vitest";
import { llmAgent, scriptedAgent, type AgentIO } from "../src/demo/agent.js";
import { createWebhookApp } from "../src/http.js";
import { guardTools } from "../src/mcp-server.js";
import { listen, SECRET, setup } from "./helpers.js";

function io(ctx: ReturnType<typeof setup>, onProposed?: (draftId: string) => Promise<void>) {
  const said: string[] = [];
  const calls: string[] = [];
  const agentIo: AgentIO = {
    tools: guardTools(ctx.guard),
    say: (t) => void said.push(t),
    async call(name, args) {
      calls.push(name);
      const data = name === "propose_payment" ? await ctx.guard.propose(args) : ctx.guard.status();
      const isError = (data as { ok?: boolean }).ok === false;
      if (!isError && name === "propose_payment") await onProposed?.((data as { proposal: { draftId: string } }).proposal.draftId);
      return { isError, data };
    },
  };
  return { agentIo, said, calls };
}

describe("scripted demo agent", () => {
  it("runs the scenario: 2 signed, 1 over budget, 1 unknown address", async () => {
    const ctx = setup({ now: { t: new Date() } }); // real time: the mock signs webhooks with it
    const hooks = await listen(createWebhookApp({ guard: ctx.guard, secret: SECRET, log: () => undefined }));
    ctx.mock.setWebhook(`${hooks.url}/webhooks/send21`, SECRET);
    const { agentIo, said } = io(ctx, async (draftId) => void (await ctx.mock.pay(draftId, "sign")));
    await scriptedAgent(agentIo);
    await hooks.close();
    const ps = ctx.store.proposals();
    expect(ps.map((p) => [p.to, p.status, p.amount])).toEqual([
      ["api-credits", "confirmed", 12_000_000],
      ["domains", "confirmed", 6_000_000],
    ]);
    expect(ctx.guard.usage().minor).toMatchObject({ spent: 18_000_000, reserved: 0, left: 2_000_000 });
    expect(said.at(-1)).toBe("Done. 18.00 USDC spent, 2.00 USDC left this week.");
  });
});

describe("LLM hook (OpenAI-compatible)", () => {
  it("sends the guard tools, runs tool calls and returns results to the model", async () => {
    const ctx = setup();
    const { agentIo, calls, said } = io(ctx);
    const requests: { model: string; tools: { function: { name: string } }[]; messages: { role: string; content?: string }[] }[] = [];
    const replies = [
      { tool_calls: [{ id: "c1", type: "function", function: { name: "budget_status", arguments: "{}" } }] },
      { tool_calls: [{ id: "c2", type: "function", function: { name: "propose_payment", arguments: JSON.stringify({ to: "domains", amount: "30", reason: "domain" }) } }] },
      { tool_calls: [{ id: "c3", type: "function", function: { name: "propose_payment", arguments: JSON.stringify({ to: "domains", amount: "6", reason: "tiny-lib.dev" }) } }] },
      { content: "Proposed tiny-lib.dev for 6 USDC; a human signs it." },
    ];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", ...replies[requests.length - 1] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await llmAgent(agentIo, { baseUrl: "http://llm.invalid/v1/", model: "any-model", fetchImpl });
    expect(requests[0]!.tools.map((t) => t.function.name)).toEqual(["propose_payment", "budget_status"]);
    expect(requests[0]!.model).toBe("any-model");
    expect(calls).toEqual(["budget_status", "propose_payment", "propose_payment"]);
    expect(requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("over_payment_max") });
    expect(ctx.store.proposals()).toHaveLength(1);
    expect(said).toEqual(["Proposed tiny-lib.dev for 6 USDC; a human signs it."]);
  });
});
