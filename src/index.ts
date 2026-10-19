#!/usr/bin/env node
import "dotenv/config";
import { loadConfig } from "./config.js";
import { BudgetGuard } from "./guard.js";
import { createAgentApp, createWebhookApp } from "./http.js";
import { createMockSend21 } from "./mock/send21.js";
import { Store } from "./store.js";
import { send21Upstream } from "./upstream.js";

// budget-guard server: MCP for the agent on localhost, webhooks from send21 on a second port.
const cfg = loadConfig();
const store = new Store(cfg.dataFile);
const mock = cfg.mock ? createMockSend21() : null;
const upstream = mock?.upstream ?? send21Upstream(cfg.send21McpUrl, cfg.send21ApiKey as string);
const guard = new BudgetGuard(cfg.policy, store, upstream, { log: (l) => console.log(`🛡️  ${l}`) });

const mockPay = mock
  ? async (id: string, action: string) => {
      const p = store.get(id);
      if (!p?.draftId) return { error: "no draft for that proposal" };
      if (!["sign", "short", "expire", "wrong-amount"].includes(action)) return { error: "action: sign | short | expire | wrong-amount" };
      return { deliveries: await mock.pay(p.draftId, action as "sign") };
    }
  : undefined;

const agentApp = createAgentApp({ guard, upstream, agentToken: cfg.agentToken, adminToken: cfg.adminToken, ...(mockPay ? { mockPay } : {}) });
const webhookApp = createWebhookApp({ guard, secret: cfg.webhookSecret, onApplied: (outcome, event) => console.log(`🪝 ${event} → ${outcome}`) });

agentApp.listen(cfg.guardPort, cfg.guardHost, () => {
  const b = guard.usage();
  console.log(`🛡️  budget-guard MCP: http://${cfg.guardHost}:${cfg.guardPort}/mcp  ·  ${b.left} left of ${b.cap} this ${b.period}`);
  if (cfg.mock) {
    console.log("🧪 MOCK mode: no send21 key, no money. Sign a proposal: POST /admin/mock/<proposal id>/sign");
    for (const name of cfg.generated) console.log(`   ${name}=${name === "GUARD_TOKEN" ? cfg.agentToken : cfg.adminToken}  (generated for this run)`);
  }
});
webhookApp.listen(cfg.webhookPort, cfg.webhookHost, () => {
  console.log(`🪝 webhooks: http://${cfg.webhookHost}:${cfg.webhookPort}/webhooks/send21 (put your HTTPS reverse proxy in front)`);
  mock?.setWebhook(`http://127.0.0.1:${cfg.webhookPort}/webhooks/send21`, cfg.webhookSecret);
});
