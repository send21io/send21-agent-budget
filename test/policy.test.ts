import { describe, expect, it } from "vitest";
import { coinById, COINS } from "../src/currencies.js";
import { formatAmount, loadPolicy, parseAmount, periodEnd, periodStart } from "../src/policy.js";
import { BASE_ADDR, policyFile, SOL } from "./helpers.js";

describe("amounts", () => {
  it("parses strictly into integer minor units", () => {
    expect(parseAmount("12", 6)).toEqual({ ok: true, minor: 12_000_000 });
    expect(parseAmount("0.1", 6)).toEqual({ ok: true, minor: 100_000 });
    expect(parseAmount(4.5, 2)).toEqual({ ok: true, minor: 450 });
    for (const bad of ["", "-1", "0", "1e3", "1,5", "12.1234567", " ", "0x10", "Infinity", null, NaN, "1.2.3"]) expect(parseAmount(bad, 6).ok).toBe(false);
    expect(parseAmount("1.005", 2).ok).toBe(false);
  });
  it("formats", () => {
    expect(formatAmount(12_000_000, { decimals: 6, unit: "USDC" })).toBe("12.00 USDC");
    expect(formatAmount(1_234_567, { decimals: 6, unit: "USDC" })).toBe("1.234567 USDC");
    expect(formatAmount(1500, { decimals: 0, unit: "JPY" })).toBe("1500 JPY");
  });
});

describe("loadPolicy", () => {
  it("loads the example", () => {
    const p = loadPolicy(policyFile());
    expect(p).toMatchObject({ unit: "USDC", unitKind: "asset", asset: "Usdc", decimals: 6, cap: 20_000_000, perPaymentMax: 15_000_000, period: "week" });
    expect(p.recipients.map((r) => r.name)).toEqual(["api-credits", "domains"]);
  });
  it("supports a fiat budget with any allowed coin", () => {
    const p = loadPolicy(policyFile({ unit: "eur", cap: "50", perPaymentMax: "20" }, { coins: ["usdc-base", "eth-base", "usdc-sol"] }));
    expect(p).toMatchObject({ unit: "EUR", unitKind: "fiat", asset: null, decimals: 2, cap: 5000 });
  });
  it("refuses unsafe or unclear policies", () => {
    const bad = [
      policyFile({ unit: "DOGE" }),
      policyFile({ period: "year" as never }),
      policyFile({ perPaymentMax: "30" }),
      policyFile({ cap: "-5" }),
      policyFile({}, { coins: ["usdc-base", "eth-base"] }), // a USDC budget cannot allow ETH
      policyFile({}, { coins: ["usdt-base"] }),
      policyFile({}, { recipients: [{ name: "x", address: SOL, coins: ["usdc-base"] }] }), // Solana address for a Base coin
      policyFile({}, { recipients: [{ name: "Bad Name", address: BASE_ADDR, coins: ["usdc-base"] }] }),
      policyFile({}, { recipients: [{ name: "x", address: "0x0000000000000000000000000000000000000000", coins: ["usdc-base"] }] }),
      policyFile({}, { recipients: [{ name: "x", address: "a".repeat(64), coins: ["usdc-base"] }] }),
      policyFile({}, { recipients: [] }),
    ];
    for (const f of bad) expect(() => loadPolicy(f)).toThrow(/budget policy/);
  });
});

describe("coins", () => {
  it("only lists documented pairs: no USDT or BTC on Base, no USDT on Tron, Arbitrum or Polygon, no Lightning drafts via MCP", () => {
    for (const id of ["usdt-base", "btc-base", "usdt-tron", "usdt-arb", "usdt-pol", "btc-ln"]) expect(coinById(id)).toBeUndefined();
    expect(COINS.filter((c) => c.currency === "Usdt").map((c) => c.network).sort()).toEqual(["Ethereum", "Solana"]);
    expect(COINS.filter((c) => c.network === "Base").map((c) => c.currency).sort()).toEqual(["Eth", "Eurc", "Usdc"]);
  });
});

describe("periods (UTC)", () => {
  const wed = new Date("2026-10-21T12:00:00Z");
  it("weeks start on Monday, months on the 1st", () => {
    expect(periodStart("week", wed).toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(periodEnd("week", wed).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(periodStart("week", new Date("2026-10-25T23:59:59Z")).toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(periodStart("month", wed).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodEnd("month", new Date("2026-12-31T23:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(periodEnd("day", wed).toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });
});
