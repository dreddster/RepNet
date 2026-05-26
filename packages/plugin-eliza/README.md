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
2. delegates execution to `createRepNetActions()`,
3. does not reintroduce direct SDK/DKG/service logic, and
4. keeps adapter-specific action/provider/service logic out of this package.
