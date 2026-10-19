/** Where a proposal stands. Reserving statuses hold budget; "confirmed" is spend; released ones count for nothing. */
export type ProposalStatus =
  | "reserving" // budget held, create_draft in flight (or its answer was lost: retry with the same purchaseId)
  | "proposed" // a send21 draft waits for a human to sign it
  | "seen" // draft.seen: a payment is on its way
  | "review" // draft.amount_mismatch / mismatch_accepted: a different amount arrived, waiting for draft.confirmed
  | "flagged" // 🚩 money may have moved but it does not match: holds budget until a human looks
  | "confirmed" // draft.confirmed that matched: counts as spend
  | "declined" // a human declined it before signing
  | "expired" // the draft expired unpaid
  | "cancelled" // the draft was cancelled
  | "failed"; // send21 refused to create it

export const RESERVING: readonly ProposalStatus[] = ["reserving", "proposed", "seen", "review", "flagged"];

export interface Proposal {
  id: string;
  purchaseId: string;
  idempotencyKey: string;
  to: string;
  address: string;
  coin: string;
  /** Minor units of the budget unit. */
  amount: number;
  unit: string;
  reason: string;
  status: ProposalStatus;
  draftId: string | null;
  coreSha256: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set on confirmed: what counted against the budget (minor units). */
  spent?: number;
  confirmedAt?: string;
  txId?: string;
  problems?: string[];
  note?: string;
}
