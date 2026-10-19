import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { BudgetGuard } from "../src/guard.js";
import { loadPolicy, type PolicyFile } from "../src/policy.js";
import { createMockSend21 } from "../src/mock/send21.js";
import { Store } from "../src/store.js";
import type { Upstream } from "../src/upstream.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const BASE_ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const NOW = new Date("2026-10-21T12:00:00.000Z"); // a Wednesday

export const policyFile = (over: Partial<PolicyFile["budget"]> = {}, rest: Partial<PolicyFile> = {}): PolicyFile => ({
  budget: { unit: "USDC", cap: "20", period: "week", perPaymentMax: "15", ...over },
  coins: ["usdc-base", "usdc-sol"],
  recipients: [
    { name: "api-credits", emoji: "🔑", label: "API credits shop", address: BASE_ADDR, coins: ["usdc-base"] },
    { name: "domains", emoji: "🌐", label: "Domain registrar", address: SOL, coins: ["usdc-sol"] },
  ],
  ...rest,
});

export function setup(opts: { file?: PolicyFile; store?: Store; upstream?: Upstream; delayMs?: number; now?: { t: Date } } = {}) {
  const clock = opts.now ?? { t: NOW };
  const mock = createMockSend21({ now: () => clock.t, ...(opts.delayMs ? { delayMs: opts.delayMs } : {}) });
  const store = opts.store ?? new Store(":memory:");
  const guard = new BudgetGuard(loadPolicy(opts.file ?? policyFile()), store, opts.upstream ?? mock.upstream, { now: () => clock.t });
  return { mock, store, guard, clock };
}

/** draft.confirmed for a mock draft, shape from docs/webhooks "Payload". */
export function confirmed(draftId: string, over: Record<string, unknown> = {}) {
  return {
    event: "draft.confirmed",
    data: { draftId, status: "Confirmed", txId: "0xabc", confirmations: 1, sentCurrency: "USDC", network: "Base", amountSats: 12_000_000, sentAmount: "12.000000", occurredAt: NOW.toISOString(), ...over },
  };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}
