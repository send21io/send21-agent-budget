import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadPolicy, type Policy, type PolicyFile } from "./policy.js";

export interface Config {
  mock: boolean;
  send21ApiKey: string | null;
  send21McpUrl: string;
  webhookSecret: string;
  policy: Policy;
  dataFile: string;
  guardHost: string;
  guardPort: number;
  agentToken: string;
  adminToken: string;
  webhookHost: string;
  webhookPort: number;
  generated: string[];
}

const port = (v: string | undefined, def: number, name: string) => {
  const n = v ? Number(v) : def;
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name}: a port number`);
  return n;
};

export function readPolicyFile(path: string): Policy {
  return loadPolicy(JSON.parse(readFileSync(path, "utf8")) as PolicyFile);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SEND21_API_KEY?.trim() || null;
  const mock = !apiKey;
  const generated: string[] = [];
  const token = (name: string): string => {
    const v = env[name]?.trim();
    if (v) {
      if (v.length < 24) throw new Error(`${name}: at least 24 characters (openssl rand -hex 24)`);
      return v;
    }
    if (!mock) throw new Error(`${name} is missing (openssl rand -hex 24)`);
    generated.push(name);
    return randomBytes(24).toString("hex");
  };
  const secret = env.SEND21_WEBHOOK_SECRET?.trim();
  if (!mock && !secret) throw new Error("SEND21_WEBHOOK_SECRET is missing (npm run webhook:register)");
  const budgetFile = env.BUDGET_FILE?.trim() || (existsSync("budget.json") ? "budget.json" : mock ? "budget.example.json" : "budget.json");
  return {
    mock,
    send21ApiKey: apiKey,
    send21McpUrl: env.SEND21_MCP_URL?.trim() || "https://send21.io/mcp",
    webhookSecret: secret || randomBytes(32).toString("hex"),
    policy: readPolicyFile(budgetFile),
    dataFile: env.DATA_FILE?.trim() || "./data/budget-guard.json",
    guardHost: env.GUARD_HOST?.trim() || "127.0.0.1",
    guardPort: port(env.GUARD_PORT, 8787, "GUARD_PORT"),
    agentToken: token("GUARD_TOKEN"),
    adminToken: token("ADMIN_TOKEN"),
    webhookHost: env.WEBHOOK_HOST?.trim() || "127.0.0.1",
    webhookPort: port(env.WEBHOOK_PORT, 8788, "WEBHOOK_PORT"),
    generated,
  };
}
