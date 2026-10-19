import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { BudgetGuard } from "./guard.js";
import { createGuardMcpServer } from "./mcp-server.js";
import { Store } from "./store.js";
import type { Upstream } from "./upstream.js";
import { verifySignatureV2 } from "./verify.js";

const secure = (_req: Request, res: Response, next: NextFunction) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  next();
};

const sameToken = (given: string | undefined, expected: string) => {
  const a = createHash("sha256").update(String(given ?? "")).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
};
const bearer = (token: string) => (req: Request, res: Response, next: NextFunction) => {
  const got = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
  if (!sameToken(got, token)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
};

/**
 * The agent side, for localhost only: POST /mcp (Streamable HTTP, stateless, Bearer GUARD_TOKEN)
 * and a small admin API for the human (Bearer ADMIN_TOKEN, a different token).
 */
export function createAgentApp(deps: { guard: BudgetGuard; upstream: Upstream; agentToken: string; adminToken: string; mockPay?: (id: string, action: string) => Promise<unknown> }): Express {
  const { guard, upstream, agentToken, adminToken, mockPay } = deps;
  if (agentToken === adminToken) throw new Error("GUARD_TOKEN and ADMIN_TOKEN must differ");
  const app = express();
  app.disable("x-powered-by");
  app.use(secure);
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/mcp", bearer(agentToken), express.json({ limit: "64kb" }), async (req, res) => {
    // Stateless: a fresh server and transport per request, like send21's own MCP server.
    const server = createGuardMcpServer(guard, upstream);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  app.all("/mcp", (_req, res) => {
    res.status(405).set("Allow", "POST").json({ error: "stateless server: POST only" });
  });

  // ---- the human's side ----
  const admin = express.Router();
  admin.use(bearer(adminToken), express.json({ limit: "4kb" }));
  admin.get("/status", (_req, res) => {
    res.json(guard.status());
  });
  admin.post("/proposals/:id/decline", (req, res) => {
    const p = guard.decline(req.params.id!);
    if (!p) {
      res.status(404).json({ error: "no open proposal with that id" });
      return;
    }
    res.json({ ok: true, proposal: guard.public(p), note: "Budget released. Cancel the draft in send21 too, so it cannot be paid by mistake." });
  });
  if (mockPay) {
    // Mock mode only: play the human's wallet. action: sign | short | expire
    admin.post("/mock/:id/:action", async (req, res) => {
      res.json(await mockPay(req.params.id!, req.params.action!));
    });
  }
  app.use("/admin", admin);
  return app;
}

/** The public side: send21 posts webhooks here (behind your HTTPS reverse proxy). Nothing else is on this port. */
export function createWebhookApp(deps: { guard: BudgetGuard; secret: string; log?: (line: string) => void; onApplied?: (outcome: string, event: string) => void }): Express {
  const { guard, secret, log = console.log, onApplied } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(secure);
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    // 1. Signature V2 + 300 s window (llms-full.txt lines 379-397). Nothing is stored for a request that fails.
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    // 2 + 3. Dedupe and apply in one write: either both are on disk or neither.
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied;
    try {
      applied = guard.store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? guard.applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    onApplied?.(applied.outcome, String(body.event));
    res.status(200).json({ ok: true, outcome: applied.outcome });
  });
  return app;
}
