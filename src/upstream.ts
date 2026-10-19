import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// The guard's only way to send21: an MCP client to https://send21.io/mcp
// (Streamable HTTP, stateless, Authorization: Bearer s21_...; llms-full.txt
// lines 9 and 476-488). In mock mode the same client talks to a local mock.

export type ToolResult = { ok: true; data: unknown; text: string } | { ok: false; error: string; data?: unknown };

export interface Upstream {
  listTools(): Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listResources(): Promise<{ uri: string; name: string; description?: string; mimeType?: string }[]>;
  readResource(uri: string): Promise<{ contents: unknown[] }>;
  getPrompt(name: string, args: Record<string, string>): Promise<unknown>;
  listPrompts(): Promise<{ name: string; description?: string; arguments?: unknown[] }[]>;
  close(): Promise<void>;
}

/** Text content of a tools/call result, parsed as JSON when it is JSON. */
export function parseToolResult(raw: unknown): ToolResult {
  const result = (raw ?? {}) as { content?: unknown; isError?: unknown };
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((c: { type?: string }) => c?.type === "text")
    .map((c: { text?: string }) => c.text ?? "")
    .join("\n");
  if (result.isError) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // plain-text error
    }
    return { ok: false, error: text.slice(0, 500) || "tool error", ...(data !== undefined ? { data } : {}) };
  }
  try {
    return { ok: true, data: JSON.parse(text), text };
  } catch {
    return { ok: true, data: text, text };
  }
}

/** An MCP client upstream. `connect` makes a fresh transport (reconnects after errors). */
export function mcpUpstream(connect: () => Transport, name = "budget-guard"): Upstream {
  let client: Promise<Client> | null = null;
  const get = () =>
    (client ??= (async () => {
      const c = new Client({ name, version: "0.1.0" });
      await c.connect(connect());
      return c;
    })().catch((err) => {
      client = null;
      throw err;
    }));
  const run = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    try {
      return await fn(await get());
    } catch (err) {
      const c = client;
      client = null; // next call reconnects
      await c?.then((x) => x.close()).catch(() => undefined);
      throw err;
    }
  };
  return {
    listTools: () => run(async (c) => (await c.listTools()).tools as never),
    callTool: (toolName, args) => run(async (c) => parseToolResult(await c.callTool({ name: toolName, arguments: args }))),
    listResources: () => run(async (c) => (await c.listResources()).resources as never),
    readResource: (uri) => run(async (c) => (await c.readResource({ uri })) as never),
    listPrompts: () => run(async (c) => (await c.listPrompts()).prompts as never),
    getPrompt: (promptName, args) => run((c) => c.getPrompt({ name: promptName, arguments: args })),
    close: async () => {
      const c = client;
      client = null;
      await c?.then((x) => x.close()).catch(() => undefined);
    },
  };
}

/** send21's MCP server with the account's key. The key never leaves this process. */
export function send21Upstream(url: string, apiKey: string): Upstream {
  return mcpUpstream(() => new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }));
}
