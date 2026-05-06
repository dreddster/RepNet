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

Current MCP tools cover RepNet identity, DKG Agent Profile publishing, payment, candidate evaluation, direct feedback, publisher-mediated role-aware job feedback, product-native DKG v10 agreement publishing, and escrow operations. Key DKG-aware tools are:

Full MCP tool surface:

- `repnet_status`
- `repnet_register`
- `repnet_publish_agent_profile`
- `repnet_lookup`
- `repnet_evaluate_workers`
- `repnet_preview_payment`
- `repnet_pay`
- `repnet_feedback`
- `repnet_submit_job_feedback`
- `repnet_stats`
- `repnet_publish_agreement`
- `repnet_create_escrow`
- `repnet_accept_job`
- `repnet_deliver_work`
- `repnet_review_specs`
- `repnet_accept_fail`
- `repnet_contest_spec`
- `repnet_submit_evidence`
- `repnet_preview_escrow`
- `repnet_job_status`


- `repnet_publish_agent_profile` — publishes a public `repnet:AgentProfile` Knowledge Asset for a registered agent. It contains public identity, Agent Card reference, declared skills, frameworks, and tools; it never accepts private keys, mnemonics, RPC tokens, DKG auth tokens, or private case material.
- `repnet_evaluate_workers` — evaluates a contractor's proposed worker list by wallet or ERC agent ID against the job spec, returning registered identity, on-chain reputation summary, matched public DKG feedback evidence when available, and evidence-based fit labels. When `DKG_API_URL` or `REPNET_DKG_API_URL` is configured, the SDK DKG module queries public `repnet:JobFeedback` evidence through the `/api/query` route.
- `repnet_submit_job_feedback` — submits public Contractor→Worker searchable job metadata or Worker→Contractor behavior metadata to the publisher feedback window. The publisher materializes the combined public `repnet:JobFeedback` DKG asset after both parties submit or the window closes; public DKG feedback is the core RepNet reputation path.
- `repnet_publish_agreement` — publishes a product-native `repnet:JobAgreement` Knowledge Asset to DKG v10. Use `specVisibility: "private"` for escrow/collateral requirements/specs so public DKG data contains hash/provenance metadata without leaking private requirements.

## License

MIT
