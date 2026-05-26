#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";
import { RepNet, REPNET_OFFICIAL_CONTEXT_GRAPH_ID, createRepNetActions } from "@repnet/sdk";

// Initialize RepNet client from environment
function createClient(): RepNet {
  const chainId = parseInt(process.env.REPNET_CHAIN_ID || "84532");
  const privateKey = process.env.REPNET_PRIVATE_KEY;
  const rpcUrl = process.env.REPNET_RPC_URL;
  const dkgApiUrl = process.env.REPNET_DKG_API_URL || process.env.DKG_API_URL;
  const dkgAuthToken = process.env.REPNET_DKG_AUTH_TOKEN || process.env.DKG_AUTH_TOKEN;
  const dkgContextGraphId = process.env.REPNET_DKG_CONTEXT_GRAPH_ID || process.env.DKG_CONTEXT_GRAPH_ID || REPNET_OFFICIAL_CONTEXT_GRAPH_ID;
  const dkgPublishRoute = process.env.REPNET_DKG_PUBLISH_ROUTE || process.env.DKG_PUBLISH_ROUTE;
  const dkgQueryRoute = process.env.REPNET_DKG_QUERY_ROUTE || process.env.DKG_QUERY_ROUTE;

  if (!privateKey) {
    throw new Error("REPNET_PRIVATE_KEY environment variable required");
  }

  const provider = new ethers.JsonRpcProvider(
    rpcUrl || (chainId === 84532 ? "https://sepolia.base.org" : "https://mainnet.base.org")
  );
  const signer = new ethers.Wallet(privateKey, provider);

  return new RepNet({
    chainId,
    signer,
    ...(dkgApiUrl ? {
      dkg: {
        mode: "node" as const,
        memory: {
          apiUrl: dkgApiUrl,
          authToken: dkgAuthToken,
          contextGraphId: dkgContextGraphId,
          publishRoute: dkgPublishRoute,
          queryRoute: dkgQueryRoute,
        },
      },
    } : {}),
  });
}

const server = new Server(
  { name: "repnet", version: "0.1.3" },
  { capabilities: { tools: {} } }
);

let repnet: RepNet;

// List available tools from the canonical SDK action registry.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const actions = createRepNetActions(repnet as any);

  return {
    tools: Object.values(actions).map((action) => ({
      name: action.name,
      description: action.description,
      inputSchema: action.inputSchema,
    })),
  };
});

// Handle tool calls through the canonical SDK action registry.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const actions = createRepNetActions(repnet as any);
  const action = actions[name];

  if (!action) {
    return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }] };
  }

  try {
    const text = await action.execute((args || {}) as Record<string, unknown>);
    return { content: [{ type: "text" as const, text }] };
  } catch (error: any) {
    return {
      content: [{ type: "text" as const, text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// Start server
async function main() {
  repnet = createClient();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("RepNet MCP Server running on stdio");
}

main().catch(console.error);
