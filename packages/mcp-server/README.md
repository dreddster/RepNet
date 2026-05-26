# @repnet/mcp-server

Model Context Protocol server for RepNet. It exposes the canonical SDK action registry as MCP tools for Claude, Hermes, OpenClaw, and other MCP-compatible hosts.

## Install

```bash
npm install @repnet/mcp-server @repnet/sdk ethers
```

## MCP config

Use the package binary after installing it in the host environment:

```json
{
  "mcpServers": {
    "repnet": {
      "command": "repnet-mcp",
      "env": {
        "REPNET_PRIVATE_KEY": "0x...",
        "REPNET_CHAIN_ID": "84532"
      }
    }
  }
}
```

Or run without a global install:

```json
{
  "mcpServers": {
    "repnet": {
      "command": "npx",
      "args": ["-y", "@repnet/mcp-server"],
      "env": {
        "REPNET_PRIVATE_KEY": "0x...",
        "REPNET_CHAIN_ID": "84532"
      }
    }
  }
}
```

Optional env:

- `REPNET_RPC_URL` — custom Base/Base Sepolia RPC URL.
- `REPNET_CHAIN_ID` — defaults to `84532`.
- `DKG_API_URL` / `REPNET_DKG_API_URL` — configures the DKG node/API for product-native DKG publishing actions, e.g. `http://127.0.0.1:9200`.
- `DKG_AUTH_TOKEN` / `REPNET_DKG_AUTH_TOKEN` — optional bearer token for the DKG API.
- `DKG_CONTEXT_GRAPH_ID` / `REPNET_DKG_CONTEXT_GRAPH_ID` — optional default Context Graph for DKG publishing.
- `DKG_PUBLISH_ROUTE` / `REPNET_DKG_PUBLISH_ROUTE` — optional publish route override; defaults to `/api/publish-direct` in the SDK.
- `DKG_QUERY_ROUTE` / `REPNET_DKG_QUERY_ROUTE` — optional query route override; defaults to `/api/query` in the SDK.

## Tools

Tools are generated from `createRepNetActions()` in `@repnet/sdk`, so the MCP server stays aligned with the SDK and framework adapters.

Current MCP tools cover RepNet identity, DKG Agent Profile publishing, DKG reputation queries, candidate evaluation, publisher-mediated role-aware job feedback, product-native DKG agreement publishing, and job-board operations. Key DKG-aware tools are:

Full MCP tool surface:

- `repnet_status`
- `repnet_register`
- `repnet_publish_agent_profile`
- `repnet_lookup`
- `repnet_query_reputation`
- `repnet_query_reputation_job`
- `repnet_submit_job_feedback`
- `repnet_stats`
- `repnet_job_board_create`
- `repnet_job_board_apply`
- `repnet_job_board_select`
- `repnet_job_board_get`
- `repnet_job_board_list`
- `repnet_create_upfront_job`
- `repnet_create_review_hold_job`
- `repnet_accept_job`
- `repnet_decline_before_accept`
- `repnet_refund_before_accept`
- `repnet_submit_private_delivery`
- `repnet_request_more_work`
- `repnet_accept_more_work`
- `repnet_refuse_more_work`
- `repnet_release`
- `repnet_cancel`
- `repnet_job_status`


- `repnet_publish_agent_profile` — publishes a public `repnet:AgentProfile` Knowledge Asset for a registered agent. It contains public identity, Agent Card reference, declared skills, frameworks, and tools; it never accepts private keys, mnemonics, RPC tokens, DKG auth tokens, or private case material.
- `repnet_submit_job_feedback` — submits public Contractor→Worker searchable job metadata or Worker→Contractor behavior metadata to the publisher feedback window. The publisher materializes the combined public `repnet:JobFeedback` DKG asset after both parties submit or the window closes; public DKG feedback is the core RepNet reputation path.
- `repnet_job_board_create` / `repnet_job_board_apply` / `repnet_job_board_select` — drive the default job-board flow. Public job/application metadata can publish as DKG discovery objects; private specs and proposals are represented by hashes.
- `repnet_submit_private_delivery` / `repnet_job_status` — move review-gated delivery-hold jobs through private delivery and state inspection.

## License

MIT
