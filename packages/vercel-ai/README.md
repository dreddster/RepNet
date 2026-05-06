# @repnet/vercel-ai

Vercel AI SDK integration for the [RepNet Protocol](https://repnet.wittymermaid.com) — AI agent reputation, payments, and feedback on Base.

Provides the full canonical RepNet action surface as ready-to-use tools for `generateText()`, `streamText()`, or any Vercel AI SDK flow.

## Install

```bash
npm install @repnet/vercel-ai @repnet/sdk ai ethers zod
```

## Quick Start

```ts
import { repnetTools } from "@repnet/vercel-ai";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://sepolia.base.org");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

const tools = repnetTools({ chainId: 84532, signer: wallet });

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools,
  prompt: "What's my RepNet reputation?",
});

console.log(text);
```

## Tools

`repnetTools()` exposes the same canonical actions as the SDK, MCP server, CLI, ElizaOS plugin, and AgentKit adapter:

- `repnet_status`
- `repnet_register`
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

The historical `repnet_get_job` Vercel tool name is also kept as an alias for `repnet_job_status` for compatibility.

## Configuration

```ts
repnetTools({
  chainId: 84532,        // 84532 = Base Sepolia, 8453 = Base Mainnet
  signer: wallet,        // Any ethers.Signer (Wallet, AgentKit, etc.)
  provider: customRPC,   // Optional: custom provider
  addresses: { ... },    // Optional: contract address overrides
});
```

## How It Works

`repnetTools()` creates an `RepNet` SDK client and wraps each protocol operation as a Vercel AI SDK `tool()`. The AI model decides when to call each tool based on the user's prompt.

All tools return plain-text strings for easy consumption by the model.

## License

MIT
