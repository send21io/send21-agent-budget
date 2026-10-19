// npm run demo: the whole loop in mock mode, no keys, no money.
//   agent ──MCP──▶ budget-guard ──MCP──▶ send21 (mock)    send21 ──signed webhook──▶ budget-guard
// Flags: --interactive (you play the human), --llm (use AGENT_LLM_* instead of the scripted agent).
import "dotenv/config";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readPolicyFile } from "../config.js";
import { coinById } from "../currencies.js";
import { parseAmount } from "../policy.js";
import { BudgetGuard, type BudgetSnapshot, type ProposeResult } from "../guard.js";
import { createAgentApp, createWebhookApp } from "../http.js";
import { createMockSend21 } from "../mock/send21.js";
import { Store } from "../store.js";
import { parseToolResult } from "../upstream.js";
import { llmAgent, scriptedAgent, TASK, type AgentIO } from "./agent.js";
import { args as fmtArgs, bar, c, line, short, shortUri, wrap } from "./ui.js";

const argv = process.argv.slice(2);
const interactive = argv.includes("--interactive");
const useLlm = argv.includes("--llm") || (!!process.env.AGENT_LLM_MODEL && !argv.includes("--scripted"));
const fast = !process.stdout.isTTY || process.env.DEMO_FAST === "1";
const pause = (ms: number) => (fast ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const out = (s = "") => console.log(s);

const policy = readPolicyFile(process.env.BUDGET_FILE?.trim() || "budget.example.json");
const store = new Store(":memory:");
const mock = createMockSend21();
const guard = new BudgetGuard(policy, store, mock.upstream);
const secret = randomBytes(32).toString("hex");
const agentToken = randomBytes(24).toString("hex");
const adminToken = randomBytes(24).toString("hex");

const num = (s: string) => s.split(" ")[0]!;
const meter = (b: BudgetSnapshot) =>
  line("💰", "budget", `${bar(b.minor)} ${c.orange(num(b.spent))} spent · ${c.yellow(num(b.reserved))} reserved · ${c.bold(num(b.left))} left ${c.gray(`of ${b.cap} / ${b.period}`)}`);

const webhookApp = createWebhookApp({
  guard,
  secret,
  log: () => undefined,
  onApplied: (outcome, event) => {
    const icon = outcome === "confirmed" ? "✅" : outcome === "seen" ? "👀" : outcome === "flagged" ? "🚩" : "📨";
    const extra = outcome === "confirmed" ? c.gray(" · V2 signature ✓ · new delivery ✓ · amount + asset match ✓ → spent") : "";
    out(line("🪝", "send21", `${icon} ${event}${extra}`, c.blue));
  },
});
const listen = (app: ReturnType<typeof createWebhookApp>) =>
  new Promise<{ url: string; close: () => void }>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => { s.closeAllConnections(); s.close(); } }));
  });

// Answers are queued, so piped input (printf 'y\nn\n' | npm run demo -- --interactive) works too.
const rl = interactive ? createInterface({ input: process.stdin }) : null;
const answers: string[] = [];
const waiting: ((s: string) => void)[] = [];
rl?.on("line", (l) => (waiting.length ? waiting.shift()!(l) : answers.push(l)));
rl?.on("close", () => waiting.splice(0).forEach((w) => w("")));
const ask = (q: string) => {
  process.stdout.write(q);
  return new Promise<string>((resolve) => (answers.length ? resolve(answers.shift()!) : waiting.push(resolve))).then((a) => {
    if (!process.stdin.isTTY) process.stdout.write(`${a}\n`);
    return a;
  });
};
const attempts: { icon: string; amount: string; to: string; what: string; id?: string }[] = [];
const ICONS: Record<string, string> = { confirmed: "✅", declined: "🙅", expired: "⌛", flagged: "🚩" };
let replayed = false;

async function main() {
  const hooks = await listen(webhookApp);
  mock.setWebhook(`${hooks.url}/webhooks/send21`, secret);
  const agentSide = await listen(createAgentApp({ guard, upstream: mock.upstream, agentToken, adminToken }));
  const client = new Client({ name: "demo-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${agentSide.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${agentToken}` } } }));
  const { tools } = await client.listTools();

  out(c.orange(c.bold("🛡️  budget-guard")) + c.gray("  ·  the agent proposes, the human signs  ·  🧪 mock, no keys, no money"));
  out(c.gray(`   ${wrap(`agent tools: ${tools.map((t) => t.name).join(", ")}`, 100).join("\n                ")}`));
  out(c.gray("─".repeat(78)));
  out(line("👤", "you", useLlm ? TASK : "Buy 3 API credit packs and a domain for tiny-lib. Budget: 20 USDC a week.", c.cream));
  await pause(400);

  const human = async (p: NonNullable<Extract<ProposeResult, { ok: true }>["proposal"]>) => {
    const r = store.get(p.id)!;
    const coin = coinById(r.coin)!;
    const rcpt = policy.recipients.find((x) => x.name === r.to)!;
    const tpl = parseToolResult(await client.callTool({ name: "get_transaction_template", arguments: { draftId: p.draftId } }));
    const uri = tpl.ok ? String((tpl.data as { paymentUri?: string }).paymentUri ?? "") : "";
    out(
      line(
        "👤",
        "human",
        [
          `${c.bold("┌ review")}  ${rcpt.emoji} ${rcpt.label} · ${c.bold(p.amount)} ${c.gray(`on ${coin.network}`)}`,
          `│ reason  ${c.cream(p.reason)}`,
          `│ to      ${short(r.address, 8, 6)}   draft ${short(p.draftId ?? "", 8, 4)}   core ${short(p.coreSha256 ?? "", 8, 4)}`,
          `│ wallet  ${c.gray(shortUri(uri))}`,
        ].join("\n"),
        c.cream,
      ),
    );
    let yes = true;
    if (rl) yes = !/^n/i.test(await ask(`${" ".repeat(12)}└ sign it in your wallet? [Y/n] `));
    if (!yes) {
      guard.decline(p.id);
      out(`${" ".repeat(12)}${c.gray("└")} 🙅 declined → budget released`);
      out(meter(guard.usage()));
      return;
    }
    if (!rl) out(`${" ".repeat(12)}${c.gray("└")} ✍️  signs in their own wallet ${c.gray("(the agent never sees a key)")}`);
    await pause(700);
    await mock.pay(p.draftId!, "sign");
    if (!replayed) {
      replayed = true;
      const again = await mock.replayLast();
      out(line("🪝", "send21", `🔁 retry of the same delivery → ${again.body?.duplicate ? c.gray("duplicate, ignored ✓") : c.red("APPLIED TWICE")}`, c.blue));
    }
    out(meter(guard.usage()));
  };

  const io: AgentIO = {
    tools: tools as AgentIO["tools"],
    say: (text) => out(line("🤖", "agent", text, c.green)),
    async call(name, a) {
      out(`${" ".repeat(12)}${wrap(`${c.gray("→")} ${c.bold(name)} ${Object.keys(a).length ? fmtArgs(a) : ""}`, 96).join(`\n${" ".repeat(14)}`)}`);
      await pause(350);
      const res = parseToolResult(await client.callTool({ name, arguments: a }));
      const data = res.ok ? res.data : (res.data ?? { ok: false, blocked: "error", reason: res.error });
      const isError = !res.ok || (data as { ok?: boolean }).ok === false;
      if (name === "budget_status" && res.ok) out(meter((data as { budget: BudgetSnapshot }).budget));
      if (name === "propose_payment") {
        const r = data as ProposeResult;
        const parsed = parseAmount(a.amount, policy.decimals);
        const amount = parsed.ok ? guard.fmt(parsed.minor) : String(a.amount);
        if (r.ok) {
          attempts.push({ icon: "📝", amount: r.proposal.amount, to: r.proposal.to, what: r.proposal.reason, id: r.proposal.id });
          out(line("🛡️", "guard", `${c.green("✅ allowed")} · ${r.proposal.amount} reserved · draft ${short(r.proposal.draftId ?? "", 8, 4)} waits for a human`, c.orange));
          out(meter(r.budget));
          await pause(400);
          await human(r.proposal);
        } else {
          attempts.push({ icon: "⛔", amount, to: short(String(a.to ?? ""), 8, 4), what: `${r.blocked}` });
          out(line("🛡️", "guard", `${c.red(`⛔ ${r.blocked}`)} ${c.gray("· never reached send21")}\n${c.gray(r.reason)}`, c.orange));
        }
      }
      await pause(300);
      return { isError, data };
    },
  };

  if (useLlm) {
    const baseUrl = process.env.AGENT_LLM_BASE_URL?.trim();
    const model = process.env.AGENT_LLM_MODEL?.trim();
    if (!baseUrl || !model) throw new Error("--llm needs AGENT_LLM_BASE_URL and AGENT_LLM_MODEL");
    await llmAgent(io, { baseUrl, model, apiKey: process.env.AGENT_LLM_API_KEY?.trim() || undefined });
  } else {
    await scriptedAgent(io);
  }

  out(c.gray("─".repeat(78)));
  for (const a of attempts) out(`   ${(a.id && ICONS[store.get(a.id)?.status ?? ""]) || a.icon} ${a.amount.padStart(10)}  ${a.to.padEnd(14)} ${c.gray(a.what)}`);
  out(meter(guard.usage()));
  out(c.gray("   send21 never holds keys or funds. Every payment that went out was signed by a human."));
  rl?.close();
  await client.close();
  agentSide.close();
  hooks.close();
  await mock.upstream.close();
}

main().catch((err) => {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
});
