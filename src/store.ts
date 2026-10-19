import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Proposal } from "./types.js";

// One JSON file, written atomically (temp file + rename). Every change runs in
// `transaction()`: memory is changed, the file is written, and only then does
// the caller go on (answer send21 with 2xx, call create_draft). If the write
// fails, the state is reloaded from disk and the error is thrown.
//
// transaction() is synchronous. Node runs one at a time, so "check the budget
// and reserve" inside one transaction cannot interleave with another proposal.
// Good for one process. For several, use a database with row locks
// (SELECT ... FOR UPDATE) or SERIALIZABLE transactions.

export interface StoreData {
  version: 1;
  proposals: Record<string, Proposal>;
  /** X-Send21-Delivery id -> first seen (ms) */
  deliveries: Record<string, number>;
  /** sha256 of the raw body -> first seen (ms): the same event under a new delivery id */
  events: Record<string, number>;
}

const empty = (): StoreData => ({ version: 1, proposals: {}, deliveries: {}, events: {} });
const KEEP_MS = 30 * 24 * 3600_000;

export class Store {
  private data: StoreData;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): StoreData {
    if (this.file === ":memory:" || !existsSync(this.file)) return empty();
    return { ...empty(), ...(JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreData>), version: 1 };
  }

  private persist(): void {
    if (this.file === ":memory:") return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Run fn against the data and write it. All or nothing. fn must be synchronous. */
  transaction<T>(fn: (d: StoreData) => T): T {
    try {
      const result = fn(this.data);
      this.persist();
      return result;
    } catch (err) {
      this.data = this.load();
      throw err;
    }
  }

  proposals(): Proposal[] {
    return Object.values(this.data.proposals);
  }

  get(id: string): Proposal | undefined {
    return this.data.proposals[id];
  }

  /**
   * Record a webhook delivery. Returns false when the delivery id or the exact
   * same body was already handled. Call inside the same transaction as the change.
   */
  static remember(d: StoreData, deliveryId: string, eventKey: string, now = Date.now()): boolean {
    if (d.deliveries[deliveryId] || d.events[eventKey]) return false;
    d.deliveries[deliveryId] = now;
    d.events[eventKey] = now;
    for (const map of [d.deliveries, d.events]) for (const [k, t] of Object.entries(map)) if (now - t > KEEP_MS) delete map[k];
    return true;
  }
}
