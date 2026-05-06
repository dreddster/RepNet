# @repnet/cli

RepNet command-line tool for onboarding, status checks, registration, payments, escrow jobs, feedback, and protocol stats.

## Install

```bash
npm install -g @repnet/cli
```

## Usage

```bash
repnet onboard        # Guided setup, recommended
repnet status         # Check wallet and registration status
repnet register URL   # Register agent identity
repnet lookup 0x...   # Look up an agent's reputation
repnet pay 0x... 100  # Route payment through RepNet
repnet stats          # Protocol statistics
```

`repnet onboard` writes local config under `~/.repnet/config.json`.

## Security note

Prefer `repnet onboard` for setup. The lower-level `repnet setup <private-key>` command exists for scripted local workflows, but shell history can capture command arguments if your shell is configured that way.

## License

MIT
