#!/usr/bin/env node
// stdio bridge for MCP clients that launch a command (Claude Desktop and others):
// it forwards everything to the running budget-guard server. Only GUARD_TOKEN is
// needed here; the send21 key stays with the server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const url = process.env.GUARD_URL?.trim() || "http://127.0.0.1:8787/mcp";
const token = process.env.GUARD_TOKEN?.trim();
if (!token) {
  console.error("GUARD_TOKEN is required");
  process.exit(1);
}

const client = new Client({ name: "budget-guard-stdio", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));

const server = new Server({ name: "budget-guard", version: "0.1.0" }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.setRequestHandler(ListToolsRequestSchema, (req) => client.listTools(req.params));
server.setRequestHandler(CallToolRequestSchema, (req) => client.callTool(req.params) as never);
server.setRequestHandler(ListResourcesRequestSchema, (req) => client.listResources(req.params));
server.setRequestHandler(ReadResourceRequestSchema, (req) => client.readResource(req.params));
server.setRequestHandler(ListPromptsRequestSchema, (req) => client.listPrompts(req.params));
server.setRequestHandler(GetPromptRequestSchema, (req) => client.getPrompt(req.params));
await server.connect(new StdioServerTransport());
