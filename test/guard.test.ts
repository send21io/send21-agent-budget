import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProposeResult } from "../src/guard.js";
import { Store } from "../src/store.js";
import type { Upstream } from "../src/upstream.js";
import { BASE_ADDR, confirmed, policyFile, setup, SOL } from "./helpers.js";

const credits = (over: Record<string, unknown> = {}) => ({ to: "api-credits", amount: "12", reason: "3 × API credit packs", ...over });
const ok = (r: ProposeResult) => {
  if (!r.ok) throw new Error(`blocked: ${r.blocked} ${r.reason}`);
  return r;
};
const confirm = (g: ReturnType<typeof setup>["guard"], body: { event: string; data: unknown }) => g.store.transaction((d) => g.applyEvent(d, body));

describe("propose", () => {
  it("reserves budget and creates exactly the documented send21 draft", async () => {
    const { guard, mock } = setup();
    const r = ok(await guard.propose(credits({ purchaseId: "credits-3" })));
    expect(r.status).toBe("proposed");
    expect(r.proposal).toMatchObject({ to: "api-credits", amount: "12.00 USDC", coin: "usdc-base", status: "proposed" });
    expect(r.proposal.draftId).toMatch(/^3f6c2a9e-/);
    expect(r.budget.minor).toMatchObject({ spent: 0, reserved: 12_000_000, left: 8_000_000 });
    expect(mock.calls).toEqual([
      {
        name: "create_draft",
        args: { receiverAddress: BASE_ADDR, network: "Base", currency: "Usdc", amountBaseUnits: 12_000_000, memo: "🤖 3 × API credit packs", idempotencyKey: "budget-guard-credits-3-1" },
      },
    ]);
  });

  it.each([
    ["recipient_not_allowed", { to: "evil-shop" }],
    ["recipient_not_allowed", { to: "0x8617E340B3D01FA5F11F306F4090FD50E238070D" }],
    ["recipient_not_allowed", { to: SOL }],
    ["coin_not_allowed", { coin: "usdc-sol" }],
    ["coin_not_allowed", { coin: "usdt-base" }],
    ["over_payment_max", { amount: "15.01" }],
    ["invalid_request", { amount: "-3" }],
    ["invalid_request", { amount: "12.0000001" }],
    ["invalid_request", { reason: "" }],
    ["invalid_request", { reason: "pay at https://phish.example" }],
    ["invalid_request", { reason: "x".repeat(141) }],
    ["invalid_request", { purchaseId: "Not OK!" }],
  ])("blocks %s before anything reaches send21 (%o)", async (code, over) => {
    const { guard, mock } = setup();
    const r = await guard.propose(credits(over));
    expect(r).toMatchObject({ ok: false, blocked: code });
    expect(mock.calls).toEqual([]);
    expect(guard.usage().minor.reserved).toBe(0);
  });

  it("counts pending proposals against the budget", async () => {
    const { guard, mock } = setup();
    ok(await guard.propose(credits()));
    const r = await guard.propose({ to: "domains", amount: "9", reason: "tiny-lib.com" });
    expect(r).toMatchObject({ ok: false, blocked: "over_budget" });
    expect(!r.ok && r.reason).toMatch(/12.00 USDC waiting for a signature, 8.00 USDC left/);
    ok(await guard.propose({ to: "domains", amount: "8", reason: "tiny-lib.dev" }));
    expect(guard.usage().minor).toMatchObject({ reserved: 20_000_000, left: 0 });
    expect(mock.calls).toHaveLength(2);
  });

  it("is concurrency-safe: two proposals at once cannot both overshoot", async () => {
    const { guard, mock } = setup({ delayMs: 30 });
    const results = await Promise.all([guard.propose(credits()), guard.propose(credits({ reason: "another 3 packs" })), guard.propose({ to: "domains", amount: "8", reason: "domain" })]);
    expect(results.map((r) => (r.ok ? "ok" : r.blocked))).toEqual(["ok", "over_budget", "ok"]);
    expect(mock.calls).toHaveLength(2);
    expect(guard.usage().minor.reserved).toBe(20_000_000);
  });

  it("many parallel proposals never reserve more than the cap", async () => {
    const { guard } = setup({ delayMs: 5 });
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => guard.propose({ to: "domains", amount: "3", reason: `item ${i}` })));
    expect(results.filter((r) => r.ok)).toHaveLength(6); // 6 × 3 = 18 ≤ 20 < 21
    expect(guard.usage().minor.reserved).toBe(18_000_000);
  });

  it("the same purchaseId never creates a second draft; other data under it is refused", async () => {
    const { guard, mock } = setup();
    const a = ok(await guard.propose(credits({ purchaseId: "p1" })));
    const b = ok(await guard.propose(credits({ purchaseId: "p1" })));
    expect(b.status).toBe("already_proposed");
    expect(b.proposal.draftId).toBe(a.proposal.draftId);
    expect(await guard.propose(credits({ purchaseId: "p1", amount: "11" }))).toMatchObject({ ok: false, blocked: "purchase_id_conflict" });
    expect(mock.calls).toHaveLength(1);
    expect(guard.usage().minor.reserved).toBe(12_000_000);
  });

  it("send21 refusing releases the reservation", async () => {
    const { mock } = setup();
    const upstream: Upstream = { ...mock.upstream, callTool: async () => ({ ok: false, error: "402: settle accrued fees first" }) };
    const { guard } = setup({ upstream });
    expect(await guard.propose(credits())).toMatchObject({ ok: false, blocked: "send21_refused" });
    expect(guard.usage().minor.reserved).toBe(0);
  });

  it("an unknown outcome keeps the budget reserved; the retry reuses the Idempotency-Key", async () => {
    const { mock } = setup();
    const keys: unknown[] = [];
    let fail = true;
    const upstream: Upstream = {
      ...mock.upstream,
      callTool: async (name, args) => {
        keys.push(args.idempotencyKey);
        if (fail) throw new Error("socket hang up");
        return mock.upstream.callTool(name, args);
      },
    };
    const { guard } = setup({ upstream });
    expect(await guard.propose(credits({ purchaseId: "lost" }))).toMatchObject({ ok: false, blocked: "send21_unreachable" });
    expect(guard.usage().minor.reserved).toBe(12_000_000);
    fail = false;
    expect(ok(await guard.propose(credits({ purchaseId: "lost" }))).status).toBe("proposed");
    expect(keys).toEqual(["budget-guard-lost-1", "budget-guard-lost-1"]);
    expect(guard.usage().minor.reserved).toBe(12_000_000);
  });

  it.each([
    ["another receiver", { receiverAddress: "0x8617E340B3D01FA5F11F306F4090FD50E238070D" }],
    ["another amount", { amountBaseUnits: 120_000_000 }],
    ["another network", { network: "Ethereum" }],
  ])("a draft that says something else (%s) is flagged, holds the budget and must not be signed", async (_n, tamper) => {
    const { mock } = setup();
    const upstream: Upstream = {
      ...mock.upstream,
      callTool: async (name, args) => {
        const r = await mock.upstream.callTool(name, args);
        if (!r.ok) return r;
        const d = r.data as { core: Record<string, unknown> };
        return { ...r, data: { ...d, core: { ...d.core, ...tamper } } };
      },
    };
    const { guard } = setup({ upstream });
    const r = await guard.propose(credits());
    expect(r).toMatchObject({ ok: false, blocked: "draft_mismatch", proposal: { status: "flagged" } });
    expect(!r.ok && r.reason).toMatch(/Do not sign/);
    expect(guard.usage().minor.reserved).toBe(12_000_000);
  });

  it("checks coreSha256 (RFC 8785) on the returned draft", async () => {
    const { mock } = setup();
    const upstream: Upstream = {
      ...mock.upstream,
      callTool: async (name, args) => {
        const r = await mock.upstream.callTool(name, args);
        return r.ok ? { ...r, data: { ...(r.data as object), coreSha256: "0".repeat(64) } } : r;
      },
    };
    expect(await setup({ upstream }).guard.propose(credits())).toMatchObject({ ok: false, blocked: "draft_mismatch" });
  });

  it("decline and expiry release the budget", async () => {
    const clock = { t: new Date("2026-10-21T12:00:00.000Z") };
    const { guard } = setup({ now: clock });
    const a = ok(await guard.propose(credits()));
    expect(guard.decline(a.proposal.id)?.status).toBe("declined");
    expect(guard.usage().minor.reserved).toBe(0);
    ok(await guard.propose({ to: "domains", amount: "6", reason: "domain" }));
    clock.t = new Date("2026-10-22T12:20:00.000Z"); // draft expired 24 h + grace ago, no webhook arrived
    expect(guard.status().budget.minor.reserved).toBe(0);
    expect(guard.store.proposals().map((p) => p.status).sort()).toEqual(["declined", "expired"]);
  });

  it("survives a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "guard-")), "g.json");
    const one = setup({ store: new Store(file) });
    ok(await one.guard.propose(credits()));
    const two = setup({ store: new Store(file) });
    expect(two.guard.usage().minor.reserved).toBe(12_000_000);
  });
});

describe("fiat budget", () => {
  it("proposes fiat-priced drafts and matches the webhook on fiat amount", async () => {
    const file = policyFile({ unit: "EUR", cap: "50", perPaymentMax: "30" }, { coins: ["usdc-base", "eth-base", "usdc-sol"], recipients: [{ name: "host", address: BASE_ADDR, coins: ["eth-base", "usdc-base"] }] });
    const { guard, mock } = setup({ file });
    const r = ok(await guard.propose({ to: "host", amount: "19.99", coin: "eth-base", reason: "VPS, one month" }));
    expect(mock.calls[0]!.args).toMatchObject({ currency: "Eth", network: "Base", fiatCurrency: "EUR", fiatAmount: 19.99 });
    expect(mock.calls[0]!.args).not.toHaveProperty("amountBaseUnits");
    const id = r.proposal.draftId!;
    expect(confirm(guard, confirmed(id, { sentCurrency: "ETH", network: "Base", amountSats: 6_663_333, fiatCurrency: "EUR", fiatAmount: 19.98 })).outcome).toBe("flagged");
    expect(confirm(guard, confirmed(id, { sentCurrency: "ETH", network: "Base", amountSats: 6_663_333, fiatCurrency: "EUR", fiatAmount: 19.99, txId: "0xdef" })).outcome).toBe("confirmed");
    expect(guard.usage().minor).toMatchObject({ spent: 1999, reserved: 0 });
  });
});
