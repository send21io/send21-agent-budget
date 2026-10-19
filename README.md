# send21 agent budget 🛡️

**Give an AI agent a spending budget, not your keys. The agent proposes, a human signs.** Built on [send21](https://send21.io), crypto pay links and API for people and AI agents.

<img src="docs/terminal-demo.png" alt="npm run demo: budget bar, two proposals signed by a human, one blocked over budget, one unknown address blocked" width="820">

<sub>A real `npm run demo` run in mock mode. No keys, no money.</sub>

- 🛡️ **budget-guard** sits between the agent and send21's MCP server: per-period cap, per-payment max, allowed recipients and coins
- ✍️ The agent can only *propose* a send21 draft; a human reviews and signs it in their own wallet
- 💰 Spend counts only verified, matching `draft.confirmed` webhooks; pending proposals reserve budget

## Quickstart

1. **Try it now, no key:** `npm install && npm run demo`. Add `-- --interactive` to play the human yourself, or `-- --llm` with `AGENT_LLM_BASE_URL` + `AGENT_LLM_MODEL` (any OpenAI-compatible endpoint, such as a local model server) to replace the scripted agent.
2. **Budget.** `cp budget.example.json budget.json`: unit (`USDC`, or a fiat like `EUR`), cap, period (`day` / `week` / `month`, UTC), per-payment max, coins and named recipients with their addresses.
3. **send21 key for the guard only.** On [send21.io/api-keys](https://send21.io/api-keys), create a key with `drafts:write` and `drafts:read` (add `webhooks:manage` for step 4). `cp .env.example .env`, fill in the key and two different tokens: `GUARD_TOKEN` (for the agent) and `ADMIN_TOKEN` (for you), each from `openssl rand -hex 24`.
4. **Webhook.** Put only `WEBHOOK_PORT` behind your own HTTPS address (for example a reverse proxy with a free Let's Encrypt certificate), set `PUBLIC_URL`, run `npm run webhook:register` and paste the printed `SEND21_WEBHOOK_SECRET` into `.env`.
5. **Run and connect your agent.** `npm run build && npm start`, then add the MCP config below to your client.

Without `SEND21_API_KEY`, `npm start` also runs in mock mode: sign a proposal with `curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:8787/admin/mock/<proposal id>/sign`.

## MCP config

Put budget-guard where you would put send21's MCP server. The agent's config holds only `GUARD_TOKEN`; the send21 key stays inside budget-guard.

**Cursor** (`.cursor/mcp.json`) and other clients that speak Streamable HTTP:

```json
{
  "mcpServers": {
    "send21-budget": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <GUARD_TOKEN>" }
    }
  }
}
```

**Claude Desktop** and other clients that launch a command (a stdio bridge to the running guard):

```json
{
  "mcpServers": {
    "send21-budget": {
      "command": "node",
      "args": ["/absolute/path/to/send21-agent-budget/dist/src/stdio.js"],
      "env": { "GUARD_URL": "http://127.0.0.1:8787/mcp", "GUARD_TOKEN": "<GUARD_TOKEN>" }
    }
  }
}
```

Both are in [`client-config/`](client-config). Compare send21's own config for the direct connection: [MCP docs](https://send21.io/docs/mcp).

| The agent gets | From |
| --- | --- |
| `propose_payment` `{ to, amount, coin?, reason, purchaseId? }` | budget-guard: checks, reserves, then calls send21 `create_draft` |
| `budget_status` | budget-guard: spent, reserved, left, reset time, recipients |
| `get_draft_status`, `get_draft`, `get_transaction_template`, `list_draft_quotes` | send21, read-only, only for drafts this guard created |
| `get_rate`, `get_fee_schedule` | send21, read-only |
| resources `send21://docs/overview`, `send21://docs/currencies`, `send21://fees/schedule`, `send21://docs/webhooks`, `send21://brand/*` | send21, public |
| prompt `check_payment` | send21 |

Not offered to the agent: `create_draft`, `create_payment_request`, `submit_lightning_proof`, `list_address_book`, `get_payment_request`, and the prompts `create_pay_link` and `handle_amount_mismatch`. Proposing is the only way to ask for money.

## How it works

```mermaid
sequenceDiagram
    participant A as AI agent
    participant G as budget-guard
    participant S as send21 MCP
    participant H as Human + own wallet
    A->>G: propose_payment { to: "domains", amount: "9", reason }
    Note over G: allowed recipient? allowed coin?<br/>≤ per-payment max?<br/>spent + reserved + 9 ≤ cap?<br/>check and reserve in one transaction
    alt blocked
        G-->>A: ⛔ over_budget + reason (nothing reaches send21)
    else allowed
        G->>S: create_draft (receiver, network, currency,<br/>amount, memo, idempotencyKey)
        S-->>G: draft (core, coreSha256)
        Note over G: draft core = what was proposed?<br/>coreSha256 holds?
        G-->>A: 📝 proposed, waiting for a human
        H->>S: reviews the draft, signs in own wallet
        S->>G: POST /webhooks/send21 draft.confirmed (signed V2)
        Note over G: verify HMAC + 300 s window, dedupe,<br/>draftId, amount and asset match<br/>→ reserved becomes spent
    end
```

A **draft** is the send21 object for "pay someone else": the human is the sender and signs it in their own wallet. Every proposal reserves its amount until the draft is confirmed (spent), expires, is cancelled or is declined by you (`POST /admin/proposals/<id>/decline`). A purchase is one `purchaseId`: a retry returns the same draft and never reserves twice; the send21 `idempotencyKey` is derived from it.

| Webhook | Proposal | Budget |
| --- | --- | --- |
| *(created)* | 📝 proposed | reserved |
| `draft.seen` | 👀 seen | reserved |
| `draft.confirmed`, matches | ✅ confirmed | **spent** (what really arrived, if an accepted amount differed) |
| `draft.confirmed`, does **not** match | 🚩 flagged | reserved until you look |
| `draft.amount_mismatch` / `draft.mismatch_accepted` | ⚠️ review | reserved |
| `draft.mismatch_rejected` / `draft.mismatch_unresolved` | 🚩 flagged (money moved, refunds are manual) | reserved |
| `draft.expired`, `draft.cancelled` | ⌛ / ✖️ | released |

Lightning is not in the coin list: send21's MCP `create_draft` has no `paymentMethod` argument, and Lightning drafts need `paymentMethod: "Lightning"`.

## Security notes

- **No keys for the agent.** The agent holds a guard token, not a send21 key, and no send21 key can move funds anyway. A human signs every payment in a wallet the agent does not control.
- **Blocked before send21.** Unknown recipients, raw addresses (prompt-injection bait), other coins, amounts above the per-payment max and anything over the period cap are refused with a reason and never reach send21.
- **Concurrency-safe.** The budget check and the reservation happen in one synchronous store transaction before the `create_draft` call, so parallel proposals cannot both pass. Tested with 50 at once. One process per data file; for several, use a database with row locks.
- **Trust, then verify.** The draft send21 returns must match the proposal (receiver, network, currency, amount) and its `coreSha256` (RFC 8785) must hold, or it is 🚩 and the agent is told not to have it signed.
- **Signature V2 only.** Webhooks are checked with `X-Send21-Signature-V2`: HMAC-SHA256 over `<t>.<delivery id>.<raw body>`, constant-time compare, refused when more than **300 s** old or in the future. A bad signature gets `401` and nothing is stored.
- **Dedupe on both sides.** send21 dedupes on its side (retries reuse the same `X-Send21-Delivery` id, and the `idempotencyKey` returns the same draft). The receiver still runs its own duplicate check: a delivery id, or the same event body under a new id, is applied once, written together with the budget change before the `2xx`. A failed write answers `500` so send21 retries.
- **Spend = confirmed and matching.** Only a `draft.confirmed` for a draft this guard created, with the proposed coin, network and exact amount (base units, or fiat cents for a fiat budget), a txId and `status: Confirmed`, counts as spent. Other integrations' drafts on the same account are ignored.
- **Clean memos.** The agent's reason becomes the draft memo the human reads: plain text, max 140, no links, no hidden or bidi characters.
- **Local by default.** The MCP port binds to `127.0.0.1` with a bearer token; the admin API needs a second, different token; only the webhook port should be public. Data is one JSON file (`DATA_FILE`, mode 600).

## Develop

```bash
npm run check   # typecheck + lint + tests (budget, concurrency, idempotency, signature, dedupe, matching, MCP, LLM hook)
FORCE_COLOR=1 DEMO_FAST=1 DEMO_WIDTH=108 npm run demo > /tmp/demo.ansi && npm run render:terminal -- /tmp/demo.ansi docs/terminal.html
```

The mock uses a snapshot of the live `tools/list`, `resources/list` and `prompts/list` (`src/mock/send21-mcp-snapshot.json`). API reference: [send21.io/docs](https://send21.io/docs) · [MCP](https://send21.io/docs/mcp) · [webhooks](https://send21.io/docs/webhooks) · [llms-full.txt](https://send21.io/llms-full.txt). More examples: [send21-examples](https://github.com/send21io/send21-examples).

Questions: [info@send21.io](mailto:info@send21.io). License: [MIT](LICENSE).
