#!/usr/bin/env node
import { createServer } from './server.js';
import type { SignerConfig } from './types.js';

function usage(): never {
  console.log(`
  @repnet/signer — RepNet Signing Sidecar

  Runs a lightweight HTTP server that signs challenges from the RepNet API Gateway.
  Your private key NEVER leaves this process.

  Usage:
    repnet-signer --key <private-key> [options]
    npx @repnet/signer --key <private-key> [options]

  Options:
    --key, -k          Private key (hex, with or without 0x prefix)
                       Can also be set via REPNET_SIGNER_KEY env var
    --port, -p         Port to listen on (default: 4001)
    --host, -h         Host to bind to (default: 127.0.0.1)
    --gateway, -g      Gateway URL to register with (optional)
    --allowed-ops      Comma-separated list of allowed operations
                       (e.g. register,feedback,escrow.create)
    --chain-id         Expected chain ID; rejects challenges for any other chain
    --allowed-contracts Comma-separated transaction target contract allowlist
    --allow-native-value Allow non-zero native token value in signed transactions
    --allow-raw        Allow raw EIP-191 message signing
    --max-age          Max challenge age in seconds (default: 300)
    --log-level        Log level: debug, info, warn, error (default: info)
    --help             Show this help message

  Examples:
    # Basic usage with env var
    REPNET_SIGNER_KEY=0xabc... repnet-signer

    # Explicit key + custom port
    repnet-signer --key 0xabc... --port 8080

    # Register with gateway + restrict to feedback only
    repnet-signer --key 0xabc... --gateway https://repnet.m3vc.org/api --allowed-ops feedback

    # Docker
    docker run -e REPNET_SIGNER_KEY=0xabc... repnet/signer
  `);
  process.exit(0);
}

function parseArgs(argv: string[]): SignerConfig {
  const args = argv.slice(2);

  let privateKey = process.env.REPNET_SIGNER_KEY || '';
  let port = 4001;
  let host = '127.0.0.1';
  let gatewayUrl: string | undefined;
  let allowedOperations: string[] | undefined;
  let expectedChainId = process.env.REPNET_SIGNER_CHAIN_ID ? parseInt(process.env.REPNET_SIGNER_CHAIN_ID, 10) : undefined;
  let allowedContracts = process.env.REPNET_SIGNER_ALLOWED_CONTRACTS
    ? process.env.REPNET_SIGNER_ALLOWED_CONTRACTS.split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  let allowNativeValueTransfer = process.env.REPNET_SIGNER_ALLOW_NATIVE_VALUE === 'true';
  let allowRawMessages = process.env.REPNET_SIGNER_ALLOW_RAW === 'true';
  let maxChallengeAgeSec = 300;
  let logLevel: SignerConfig['logLevel'] = 'info';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      if (i + 1 >= args.length) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      return args[++i];
    };

    switch (arg) {
      case '--key': case '-k':
        privateKey = next();
        break;
      case '--port': case '-p':
        port = parseInt(next(), 10);
        break;
      case '--host': case '-h':
        host = next();
        break;
      case '--gateway': case '-g':
        gatewayUrl = next();
        break;
      case '--allowed-ops':
        allowedOperations = next().split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--chain-id':
        expectedChainId = parseInt(next(), 10);
        break;
      case '--allowed-contracts':
        allowedContracts = next().split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--allow-native-value':
        allowNativeValueTransfer = true;
        break;
      case '--allow-raw':
        allowRawMessages = true;
        break;
      case '--max-age':
        maxChallengeAgeSec = parseInt(next(), 10);
        break;
      case '--log-level':
        logLevel = next() as SignerConfig['logLevel'];
        break;
      case '--help':
        usage();
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        usage();
    }
  }

  if (!privateKey) {
    console.error('Error: Private key required. Use --key or REPNET_SIGNER_KEY env var.');
    console.error('Run with --help for usage.');
    process.exit(1);
  }

  return {
    privateKey,
    port,
    host,
    gatewayUrl,
    allowedOperations,
    expectedChainId,
    allowedContracts,
    allowNativeValueTransfer,
    allowRawMessages,
    maxChallengeAgeSec,
    logLevel,
  };
}

async function main() {
  const config = parseArgs(process.argv);

  console.log(`
  ┌─────────────────────────────────────────────┐
  │  @repnet/signer v0.1.0                      │
  │  RepNet Signing Sidecar                     │
  │                                             │
  │  Your key stays HERE. Always.               │
  └─────────────────────────────────────────────┘
  `);

  const app = await createServer(config);

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      console.log(`\n${signal} received. Shutting down...`);
      await app.close();
      process.exit(0);
    });
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
