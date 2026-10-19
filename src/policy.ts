import { ASSET_DECIMALS, assetFor, checkAddress, coinById, fiatDecimals, isFiat, type Coin, type Send21Currency } from "./currencies.js";

// The budget the human gives the agent, loaded from a JSON file (budget.json).
// Every amount inside the guard is an integer in the budget unit's smallest
// unit: micro-USDC for a USDC budget (6 decimals), cents for a EUR budget.

export type Period = "day" | "week" | "month";

export interface Recipient {
  /** What the agent passes as `to`. Lowercase, a-z 0-9 and dashes. */
  name: string;
  emoji: string;
  label: string;
  address: string;
  /** Coin ids this recipient takes (each must also be in policy.coins). */
  coins: string[];
}

export interface Policy {
  /** "USDC" (an asset: exact crypto drafts in that asset) or "EUR" (fiat: fiat-priced drafts, any allowed coin). */
  unit: string;
  unitKind: "asset" | "fiat";
  asset: Send21Currency | null;
  decimals: number;
  period: Period;
  /** Per period, in minor units. */
  cap: number;
  /** Per payment, in minor units. */
  perPaymentMax: number;
  coins: Coin[];
  recipients: Recipient[];
  /** Hours a reservation lives when send21 returns no expiresAt. */
  reserveHours: number;
}

export interface PolicyFile {
  budget: { unit: string; cap: string | number; period: Period; perPaymentMax: string | number };
  coins: string[];
  recipients: { name: string; emoji?: string; label?: string; address: string; coins: string[] }[];
  reserveHours?: number;
}

export type Parsed = { ok: true; minor: number } | { ok: false; error: string };

/** "12.5" → 12_500_000 for 6 decimals. Strict: digits, one dot, at most `decimals` decimals, above 0. */
export function parseAmount(raw: unknown, decimals: number): Parsed {
  const s = typeof raw === "number" ? (Number.isFinite(raw) ? String(raw) : "") : String(raw ?? "").trim();
  const m = /^(\d{1,12})(?:\.(\d+))?$/.exec(s);
  if (!m) return { ok: false, error: "amount must be a plain positive number like 12.5" };
  const frac = m[2] ?? "";
  if (frac.length > decimals) return { ok: false, error: `amount has more than ${decimals} decimals` };
  const minor = Number(m[1]) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
  if (!Number.isSafeInteger(minor) || minor <= 0) return { ok: false, error: "amount must be above 0" };
  return { ok: true, minor };
}

/** 12_500_000 → "12.50 USDC" (at least 2 decimals, trailing zeros trimmed beyond that). */
export function formatAmount(minor: number, p: Pick<Policy, "decimals" | "unit">): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** p.decimals);
  let frac = String(abs % 10 ** p.decimals).padStart(p.decimals, "0").replace(/0+$/, "");
  if (p.decimals >= 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""} ${p.unit}`;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function loadPolicy(file: PolicyFile): Policy {
  const fail = (msg: string): never => {
    throw new Error(`budget policy: ${msg}`);
  };
  const b = file?.budget ?? fail("missing budget");
  const unit = String(b.unit ?? "").trim().toUpperCase();
  const asset = assetFor(unit) ?? null;
  if (!asset && !isFiat(unit)) fail(`unit "${b.unit}" is neither an asset (USDC, EURC, ...) nor a supported fiat (EUR, USD, ...)`);
  const decimals = asset ? ASSET_DECIMALS[asset] : fiatDecimals(unit);
  if (!["day", "week", "month"].includes(b.period)) fail('period must be "day", "week" or "month"');
  const cap = parseAmount(b.cap, decimals);
  if (!cap.ok) fail(`cap: ${cap.error}`);
  const max = parseAmount(b.perPaymentMax, decimals);
  if (!max.ok) fail(`perPaymentMax: ${max.error}`);
  const capMinor = (cap as { minor: number }).minor;
  const maxMinor = (max as { minor: number }).minor;
  if (maxMinor > capMinor) fail("perPaymentMax is above the cap");

  const coins = (file.coins ?? []).map((id) => coinById(id) ?? fail(`unknown coin "${id}" (see src/currencies.ts)`));
  if (!coins.length) fail("allow at least one coin");
  if (new Set(coins.map((c) => c.id)).size !== coins.length) fail("a coin is listed twice");
  // An asset budget counts exact amounts of that asset: every coin must be that asset.
  if (asset) for (const c of coins) if (c.currency !== asset) fail(`a ${unit} budget can only allow ${unit} coins, not ${c.id}`);

  const recipients: Recipient[] = (file.recipients ?? []).map((r) => {
    const name = String(r.name ?? "");
    if (!NAME.test(name)) fail(`recipient name "${name}": lowercase a-z, 0-9 and dashes, max 32`);
    if (!r.coins?.length) fail(`recipient ${name}: list its coins`);
    let address = "";
    for (const id of r.coins) {
      const coin = coins.find((c) => c.id === id) ?? fail(`recipient ${name}: coin ${id} is not in the allowed coins`);
      const check = checkAddress(coin, r.address);
      if (!check.ok) fail(`recipient ${name} (${id}): ${check.error}`);
      address = (check as { address: string }).address;
    }
    return { name, emoji: r.emoji ?? "🏪", label: String(r.label ?? name).slice(0, 48), address, coins: [...r.coins] };
  });
  if (!recipients.length) fail("allow at least one recipient");
  if (new Set(recipients.map((r) => r.name)).size !== recipients.length) fail("a recipient name is listed twice");
  const reserveHours = file.reserveHours ?? 72;
  if (!Number.isInteger(reserveHours) || reserveHours < 1 || reserveHours > 720) fail("reserveHours: 1 to 720");

  return { unit, unitKind: asset ? "asset" : "fiat", asset, decimals, period: b.period, cap: capMinor, perPaymentMax: maxMinor, coins, recipients, reserveHours };
}

// ---------- periods (UTC calendar: day, ISO week from Monday, month) ----------

export function periodStart(period: Period, now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "week") d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  if (period === "month") d.setUTCDate(1);
  return d;
}

export function periodEnd(period: Period, now: Date): Date {
  const d = periodStart(period, now);
  if (period === "day") d.setUTCDate(d.getUTCDate() + 1);
  if (period === "week") d.setUTCDate(d.getUTCDate() + 7);
  if (period === "month") d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}
