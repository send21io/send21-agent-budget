// Tiny terminal UI: colours, a budget bar, labelled chat lines. NO_COLOR is respected.

const useColor = () => (process.env.FORCE_COLOR ? process.env.FORCE_COLOR !== "0" : !process.env.NO_COLOR && !!process.stdout.isTTY);
const sgr = (code: string) => (s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  bold: sgr("1"),
  dim: sgr("2"),
  orange: sgr("38;5;208"),
  yellow: sgr("38;5;221"),
  green: sgr("38;5;114"),
  red: sgr("38;5;203"),
  blue: sgr("38;5;111"),
  gray: sgr("38;5;244"),
  cream: sgr("38;5;230"),
};

export interface Meter {
  cap: number;
  spent: number;
  reserved: number;
}

/** [████▓▓▓░░░░] spent (orange), reserved (yellow), free (gray). */
export function bar(m: Meter, width = 24): string {
  const cells = (n: number) => Math.round((Math.min(n, m.cap) / m.cap) * width);
  const s = cells(m.spent);
  const r = Math.min(width - s, cells(m.spent + m.reserved) - s);
  const over = m.spent + m.reserved > m.cap;
  return `${c.gray("[")}${(over ? c.red : c.orange)("█".repeat(s))}${c.yellow("▓".repeat(r))}${c.gray("░".repeat(width - s - r))}${c.gray("]")}`;
}

const LABEL_WIDTH = 9;
const WIDTH = Number(process.env.DEMO_WIDTH) || Math.min(process.stdout.columns || 100, 110);
// eslint-disable-next-line no-control-regex
const visible = (s: string) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;

/** Word-wrap one line to `width` visible characters (ANSI codes do not count). */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && visible(cur) + 1 + visible(word) > width) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  out.push(cur);
  return out;
}

/** "🤖 agent   text", wrapped, continuation lines indented. */
export function line(icon: string, label: string, text: string, color: (s: string) => string = (s) => s): string {
  const pad = " ".repeat(Math.max(1, LABEL_WIDTH - label.length));
  const indent = " ".repeat(3 + LABEL_WIDTH);
  const rows = text.split("\n").flatMap((t) => wrap(t, WIDTH - indent.length));
  return `${icon} ${color(c.bold(label))}${pad}${rows.join(`\n${indent}`)}`;
}

/** Compact one-line args: { to: "domains", amount: "6" } */
export function args(a: Record<string, unknown>): string {
  const parts = Object.entries(a).map(([k, v]) => `${k}: ${c.cream(JSON.stringify(v))}`);
  return `{ ${parts.join(", ")} }`;
}

export const short = (s: string, head = 6, tail = 4) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);

/**
 * A wallet URI for a human to check: shortens each address inside it but keeps the
 * scheme, chain id (@8453), token and amount visible. Cutting the whole URI in the
 * middle hid exactly the parts a reviewer has to see.
 */
export const shortUri = (uri: string) => uri.replace(/0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/g, (a) => short(a, 6, 4));
