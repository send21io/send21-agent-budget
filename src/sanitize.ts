// Cleaning text that comes from the agent (a reason, a purchase id). The
// reason ends up in the draft memo that the human reads before signing, so it
// must be plain, short and unable to hide anything.

// C0/C1 controls, zero-width characters and bidi overrides (used for spoofing).
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Clickable links in a memo are a phishing vector. Plain names like "tiny-lib.dev" are fine.
const LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

/** One line of plain text, invisible characters removed, max `max` characters. Null when empty or not allowed. */
export function cleanText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  if (!s || LINK.test(s) || /[<>]/.test(s)) return null;
  return [...s].length > max ? null : s;
}

export const PURCHASE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
