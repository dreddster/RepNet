# @repnet/plugin-eliza

RepNet canonical action adapter for ElizaOS.

This package is a thin adapter over the canonical RepNet action registry in `@repnet/sdk`. It does **not** call RepNet SDK modules directly, publish DKG receipts itself, or carry separate action/service/provider business logic.

## Usage

```typescript
import { RepNet } from "@repnet/sdk";
import { createRepNetPlugin } from "@repnet/plugin-eliza";

const repnet = new RepNet({
  chainId: 84532,
  signer,
});

export default {
  plugins: [
    createRepNetPlugin({ client: repnet }),
  ],
};
```

If the RepNet SDK client must be created from the active Eliza runtime, pass a synchronous factory:

```typescript
const plugin = createRepNetPlugin({
  createClient: (runtime) => makeRepNetClient(runtime),
});
```

## Input mapping

The adapter delegates execution to `createRepNetActions()`. By default it reads structured action input from:

1. `handlerOptions.input`,
2. `message.content.input`,
3. or the whole `message.content` object.

For production agents with natural-language extraction, pass a custom `getInput` function:

```typescript
const plugin = createRepNetPlugin({
  client: repnet,
  getInput: async (actionName, runtime, message) => {
    return extractRepNetInput(actionName, message.content.text);
  },
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
2. delegates execution to `createRepNetActions()`,
3. does not reintroduce direct SDK/DKG/service logic, and
4. keeps adapter-specific action/provider/service logic out of this package.
