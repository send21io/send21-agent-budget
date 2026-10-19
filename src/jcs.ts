import { createHash } from "node:crypto";

// RFC 8785 (JCS) canonical JSON, enough for send21's draft core and quotes:
// members sorted by key, no whitespace, strings and numbers as JSON.stringify
// writes them (llms-full.txt "How to hash", lines 649-656).
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
