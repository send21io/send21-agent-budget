import { describe, expect, it } from "vitest";
import { shortUri } from "../src/demo/ui.js";
import { resetLabel } from "../src/guard.js";

describe("demo review screen", () => {
  it("keeps the chain id, recipient and amount of a wallet URI visible (a middle cut hid them)", () => {
    const uri = "ethereum:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913@8453/transfer?address=0x52908400098527886E0F7030069857D2E4169EE7&uint256=12000000";
    expect(shortUri(uri)).toBe("ethereum:0x8335…2913@8453/transfer?address=0x5290…9EE7&uint256=12000000");
    expect(shortUri("solana:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU?amount=6&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(
      "solana:7xKXtg…gAsU?amount=6&spl-token=EPjFWd…Dt1v",
    );
  });

  it("says when the budget resets in words, not a raw ISO timestamp", () => {
    expect(resetLabel("2026-10-26T00:00:00.000Z")).toBe("Mon 26 Oct 00:00 UTC");
  });
});
