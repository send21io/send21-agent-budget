import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebhookApp } from "../src/http.js";
import { Store } from "../src/store.js";
import { confirmed, deliver, listen, setup, SECRET } from "./helpers.js";

let dir: string;
let file: string;
let ctx: ReturnType<typeof setup>;
let server: Awaited<ReturnType<typeof listen>>;
let draftId: string;
const status = () => ctx.store.proposals()[0]!.status;
const budget = () => ctx.guard.usage().minor;

async function start() {
  ctx = setup({ store: new Store(file), now: ctx?.clock });
  server = await listen(createWebhookApp({ guard: ctx.guard, secret: SECRET, log: () => undefined }));
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "guard-hook-"));
  file = join(dir, "g.json");
  await start();
  const r = await ctx.guard.propose({ to: "api-credits", amount: "12", reason: "3 credit packs" });
  draftId = r.ok ? r.proposal.draftId! : "";
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook → budget", () => {
  it("a matching draft.confirmed turns the reservation into spend", async () => {
    expect(budget()).toMatchObject({ spent: 0, reserved: 12_000_000 });
    expect(await (await deliver(server.url, confirmed(draftId))).json()).toEqual({ ok: true, outcome: "confirmed" });
    expect(budget()).toMatchObject({ spent: 12_000_000, reserved: 0, left: 8_000_000 });
  });

  it("401 for a bad signature, another secret or an old delivery, and nothing changes", async () => {
    expect((await deliver(server.url, confirmed(draftId), { secret: "nope" })).status).toBe(401);
    expect((await deliver(server.url, confirmed(draftId), { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    const r = await fetch(`${server.url}/webhooks/send21`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(confirmed(draftId)) });
    expect(r.status).toBe(401);
    expect(status()).toBe("proposed");
  });

  it("400 for a signed body that is not a JSON object", async () => {
    expect((await deliver(server.url, null, { raw: "nope" })).status).toBe(400);
    expect((await deliver(server.url, null, { raw: "[]" })).status).toBe(400);
  });

  it("dedupes a retried delivery id and the same body under a new id", async () => {
    const body = confirmed(draftId);
    await deliver(server.url, body, { deliveryId: "d1" });
    expect(await (await deliver(server.url, { event: "draft.expired", data: { draftId } }, { deliveryId: "d1" })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(server.url, body, { deliveryId: "d2" })).json()).toEqual({ ok: true, duplicate: true });
    expect(budget().spent).toBe(12_000_000);
  });

  it("dedupe survives a restart", async () => {
    await deliver(server.url, { event: "draft.seen", data: { draftId } }, { deliveryId: "keep" });
    await server.close();
    await start();
    expect(await (await deliver(server.url, confirmed(draftId), { deliveryId: "keep" })).json()).toEqual({ ok: true, duplicate: true });
    expect(status()).toBe("seen");
  });

  it("500 and forgotten when the write fails, so send21 retries", async () => {
    const spy = vi.spyOn(ctx.store as unknown as { persist: () => void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await deliver(server.url, confirmed(draftId), { deliveryId: "r" })).status).toBe(500);
    expect(status()).toBe("proposed");
    spy.mockRestore();
    expect(await (await deliver(server.url, confirmed(draftId), { deliveryId: "r" })).json()).toMatchObject({ outcome: "confirmed" });
  });

  it.each([
    ["amount", { amountSats: 1_200_000 }],
    ["asset", { sentCurrency: "USDT", network: "Ethereum" }],
    ["network", { network: "Polygon" }],
    ["status", { status: "Seen" }],
    ["txId", { txId: "" }],
  ])("a confirmed payment with the wrong %s is flagged: held, not spent", async (_n, over) => {
    expect(await (await deliver(server.url, confirmed(draftId, over))).json()).toMatchObject({ outcome: "flagged" });
    expect(budget()).toMatchObject({ spent: 0, reserved: 12_000_000 });
  });

  it("ignores drafts from other integrations and unrelated events", async () => {
    expect(await (await deliver(server.url, confirmed("someone-elses-draft"))).json()).toMatchObject({ outcome: "unknown_draft" });
    expect(await (await deliver(server.url, { event: "test", data: {} })).json()).toMatchObject({ outcome: "test" });
    expect(await (await deliver(server.url, { event: "draft.mismatch_reminder", data: { draftId } })).json()).toMatchObject({ outcome: "ignored" });
    expect(budget().reserved).toBe(12_000_000);
  });

  it("expired or cancelled releases; confirmed is final", async () => {
    expect(await (await deliver(server.url, { event: "draft.expired", data: { draftId, status: "Expired" } })).json()).toMatchObject({ outcome: "expired" });
    expect(budget().reserved).toBe(0);
    // A late payment still counts (the money left the wallet).
    await deliver(server.url, confirmed(draftId, { txId: "late" }));
    expect(budget().spent).toBe(12_000_000);
    await deliver(server.url, { event: "draft.cancelled", data: { draftId } });
    expect(status()).toBe("confirmed");
  });

  it("a different amount waits; rejected or unresolved money stays held for a human", async () => {
    await deliver(server.url, { event: "draft.amount_mismatch", data: { draftId, receivedAmountSats: 11_400_000, reviewState: "pending" } });
    expect(status()).toBe("review");
    await deliver(server.url, { event: "draft.cancelled", data: { draftId } });
    expect(status()).toBe("review"); // money arrived: cancel does not release it
    await deliver(server.url, { event: "draft.mismatch_rejected", data: { draftId } });
    expect(status()).toBe("flagged");
    expect(budget()).toMatchObject({ spent: 0, reserved: 12_000_000 });
  });

  it("an accepted short payment counts what really arrived", async () => {
    await deliver(server.url, { event: "draft.mismatch_accepted", data: { draftId } });
    await deliver(server.url, confirmed(draftId, { receivedAmountSats: 11_760_000 }));
    expect(budget()).toMatchObject({ spent: 11_760_000, reserved: 0 });
  });

  it("spend from last period does not count this period", async () => {
    await deliver(server.url, confirmed(draftId));
    ctx.clock.t = new Date("2026-10-27T09:00:00.000Z"); // next Tuesday
    expect(budget()).toMatchObject({ spent: 0, left: 20_000_000 });
  });
});
