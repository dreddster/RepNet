# @repnet/agentkit-plugin

RepNet action provider for [Coinbase AgentKit](https://github.com/coinbase/agentkit).

This package is a thin adapter over the canonical RepNet action registry in `@repnet/sdk`. It does **not** encode ABIs, call contracts directly, or duplicate protocol business logic.

## Usage

```typescript
import { AgentKit } from "@coinbase/agentkit";
import { RepNet } from "@repnet/sdk";
import { repnetActionProvider } from "@repnet/agentkit-plugin";

const repnet = new RepNet({
  chainId: 84532,
  signer,
});

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [repnetActionProvider({ client: repnet })],
});
```

If your app creates the RepNet SDK client from the active AgentKit wallet, pass a synchronous factory:

```typescript
const provider = repnetActionProvider({
  createClient: (walletProvider) => makeRepNetClient(walletProvider),
});
```

## Actions

The action surface is inherited from `createRepNetActions()` in `@repnet/sdk`:

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

## Development guardrail

The test suite enforces that this adapter:

1. exposes exactly the canonical action names,
2. delegates execution to `createRepNetActions()`, and
3. does not reintroduce direct ABI/protocol execution patterns such as `encodeFunctionData`, `readContract`, or `sendTransaction`.
