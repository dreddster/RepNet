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

## Development guardrail

The test suite enforces that this adapter:

1. exposes exactly the canonical action names,
2. delegates execution to `createRepNetActions()`, and
3. does not reintroduce direct ABI/protocol execution patterns such as `encodeFunctionData`, `readContract`, or `sendTransaction`.
