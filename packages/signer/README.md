# @repnet/signer

**RepNet Signing Sidecar** — a lightweight signing proxy that keeps your private key on YOUR infrastructure.

The RepNet API Gateway holds **zero private keys**. When a write operation needs a signature, the gateway sends a signing challenge to your signer sidecar, which signs locally and returns the signature. Your key never leaves your environment.

## Quick Start

```bash
# Via npx (no install needed)
npx @repnet/signer --key 0xYOUR_PRIVATE_KEY

# Or install globally
npm install -g @repnet/signer
repnet-signer --key 0xYOUR_PRIVATE_KEY
```

## How It Works

```
Your Infrastructure          RepNet Gateway
┌──────────────────┐        ┌──────────────────┐
│  Your App        │──REST──│  REST API         │
│                  │        │                   │
│  @repnet/signer  │◀─challenge──│              │
│  (has your key)  │──signature──│              │──▶ on-chain
│                  │        │  (no keys!)       │
└──────────────────┘        └──────────────────┘
```

1. Your app calls the RepNet Gateway REST API
2. Gateway builds an unsigned transaction
3. Gateway sends a signing challenge to your sidecar (`POST /sign`)
4. Sidecar validates the challenge (expiry, nonce, operation allowlist)
5. Sidecar signs locally and returns the signature
6. Gateway submits the signed transaction on-chain

## Security Features

- **Key isolation**: Private key never leaves the signer process
- **Challenge expiry**: Auto-rejects challenges older than 5 minutes (configurable)
- **Replay protection**: Nonce tracking prevents challenge replay
- **Operation allowlist**: Restrict which operations can be signed
- **Bind to localhost**: Default bind is 127.0.0.1 (not exposed to network)

## CLI Options

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `--key, -k` | `REPNET_SIGNER_KEY` | (required) | Private key (hex) |
| `--port, -p` | | 4001 | Port to listen on |
| `--host` | | 127.0.0.1 | Bind address |
| `--gateway, -g` | | — | Gateway URL to register with |
| `--allowed-ops` | | all | Comma-separated operation allowlist |
| `--max-age` | | 300 | Max challenge age (seconds) |
| `--log-level` | | info | debug/info/warn/error |

## Library Usage

Embed the signer directly in your application:

```typescript
import { RepNetSigner } from '@repnet/signer';

const signer = new RepNetSigner({
  privateKey: process.env.PRIVATE_KEY!,
  port: 4001,
  host: '127.0.0.1',
  maxChallengeAgeSec: 300,
  logLevel: 'info',
});

// Sign a challenge programmatically
const response = await signer.sign(challenge);

// Or start the HTTP server
import { createServer } from '@repnet/signer';
await createServer({ ...config });
```

## Docker

```bash
docker run -p 4001:4001 \
  -e REPNET_SIGNER_KEY=0xYOUR_PRIVATE_KEY \
  repnet/signer
```

## Signing Challenge Format

```json
{
  "challengeId": "ch_abc123",
  "operation": "register",
  "description": "Register agent 'MyBot' on Base Sepolia",
  "message": "0x...",
  "chainId": 84532,
  "createdAt": "2026-03-01T20:00:00Z",
  "expiresAt": "2026-03-01T20:05:00Z",
  "nonce": 42
}
```

Supports three signing modes:
- **Raw message** (`message` field) — EIP-191 personal_sign
- **Typed data** (`typedData` field) — EIP-712
- **Transaction** (`transaction` field) — raw transaction signing

## License

MIT
