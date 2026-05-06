# RepNet DKG Integration Design Brief

- Package: `@repnet/mcp-server`
- Supporting packages: `@repnet/sdk`, `@repnet/cli`
- Bounty tag: `cfi-dkgv10-r1`
- Maintainer: Milian Istatkov (`istatkov@tuta.com`)
- Website: https://repnet.io
- Tier target: Flagship

## Submission status

- Published packages: `@repnet/sdk@0.1.2`, `@repnet/mcp-server@0.1.2`, `@repnet/cli@0.1.2`.
- CI: passing on `main`.
- DKG Shared Memory: live smoke passed for a redacted `repnet:DisputeCase` written through `/api/shared-memory/write` and queried back with `includeSharedMemory`.
- Demo evidence: agent onboarding is recorded; job and disputed escrow recordings are pending OriginTrail team resolution of the KA upload/finality issue.
- Registry PR: pending final demo links and registry entry.

## Summary

RepNet gives AI agents a DKG-backed trust layer for choosing counterparties. Agreements, payments, delivery outcomes, disputes, feedback, and reputation signals become structured memory that future agents query before hiring, paying, delegating, collaborating, or trusting.

## The Solution

RepNet gives agents a portable work history. Agents register an identity on Base, use RepNet for payments or escrow, and leave public feedback after the job. The on-chain record keeps the core facts verifiable. OriginTrail DKG makes the public job metadata searchable across agent tools and marketplaces.

## Problem

AI agents can discover each other, message, pay, delegate tasks, and collaborate across tools. They still lack portable, agent-readable counterparty history: prior interactions, public feedback, delivery context, dispute outcomes, payment behavior, and provenance.

Without shared memory, every marketplace, chat, and agent host becomes its own reputation silo, rarely accessible outside of it.

## Target users

- Contractor agents deciding which proposed worker, tool, or service agent to use.
- Worker and service agents building portable evidence of reliability.
- Agent teams using Hermes, OpenClaw, Claude Code, Cursor-like environments, or any MCP-compatible host.
- Marketplaces and automation tools that want to consume RepNet identity, escrow, payment, feedback, and DKG memory without implementing the protocol from scratch.

## Integration

The main package for agent users is the RepNet MCP server. It lets MCP-compatible agents call RepNet tools for identity, counterparty evaluation, agreement publication, feedback, payment, escrow, delivery, and settlement. The shared TypeScript SDK keeps the MCP server, CLI, and framework adapters aligned.

- Package: `@repnet/mcp-server`
- Agents use RepNet through MCP tools.
- RepNet talks to a configured DKG node through its HTTP API.
- Shared implementation: `@repnet/sdk`

## Memory arc

RepNet follows the DKG memory lifecycle: private job and dispute material starts in Working Memory, redacted case manifests move into Shared Memory for Context Graph peers, and safe public artifacts are published as Verified Memory.

- **Working Memory:** private active job/dispute case files: specs, terms, deadlines, delivery evidence, and party-submitted evidence.
- **Shared Memory:** before judging, RepNet packages dispute Working Memory into a redacted `repnet:DisputeCase` manifest: identifiers, parties, agreement/spec metadata, evidence references, summaries, deadlines, and SHA-256 evidence hashes. RepNet writes the manifest as RDF quads to DKG Shared Memory; LLM judges receive that shared manifest plus authorized private payloads kept in the resolver path.
- **Verified Memory:** RepNet uploads public Agent Profiles, Job Agreements, Job Feedback, receipts, and final dispute reasoning as DKG Knowledge Assets with locators and hash-anchored provenance.

## DKG v10 primitives used

- **Context Graph:** groups RepNet interaction, feedback, and agreement memory under a configured graph boundary.
- **Knowledge Asset:** represents product-native artifacts such as `repnet:JobAgreement` and `repnet:JobFeedback`.
- **Assertion / Entity / UAL:** structure agreements, feedback, job metadata, proof references, wallets, ERC-8004 identities, counterparties, and DKG locators as a linkable trust trail.

## Product memory model

RepNet’s core pattern is simple: agents need evidence before trusting a counterparty, and each completed interaction improves the next decision.

1. An agent registers on-chain and publishes a public `repnet:AgentProfile` Knowledge Asset.
2. Another agent evaluates candidate counterparties using on-chain reputation, Agent Profile data, and public DKG evidence.
3. The parties create a payment, escrow job, delegation, or collaboration record.
4. Delivery, review, and role-aware feedback produce public `repnet:JobFeedback` / receipt evidence.
5. Escrow disputes add private agreement/evidence material, a redacted Shared Memory case file, LLM judge verdicts, settlement, and final dispute reasoning.
6. Future agents query the resulting evidence through RepNet tools before hiring, paying, delegating, collaborating, or trusting.

## Promotion path and oracle readiness

RepNet’s public DKG artifacts move from active working state into verifiable evidence without changing the product model. Agent Profiles, Job Agreements, Job Feedback, receipts, and final dispute reasoning keep the same core identifiers, proof references, hashes, timestamps, and parties across Working, Shared, and Verified Memory.

Public receipts and feedback preserve agent identity, wallet, job ID, proof URI, DKG UAL, outcome, role-specific feedback, public metadata, agreement hash, and timestamp. RepNet anchor events commit the published locator hash, content hash, public root, and private root on-chain, giving agents and context-oracle pipelines verifiable inputs for task-specific reliability queries.

## LLM-Wiki and autoresearch

RepNet’s public receipts and feedback create an aggregate view of how agents are used in the economy: job categories, work types, deliverables, tools, payment amounts, outcomes, dispute patterns, and role-aware feedback. Over time, this data becomes a valuable source of knowledge for AI research, market analysis, trend prediction, agent benchmarking, and reputation-aware discovery without exposing private specifications or dispute evidence.

## Security and trust boundaries

RepNet keeps agent packages, user credentials, and RepNet-operated publishing infrastructure separate.

- Network egress: user-selected Base/Base Sepolia RPC, configured DKG node HTTP API, and RepNet publisher API.
- Credentials handled: wallet private key for local signing, RPC URL, DKG API URL/token/Context Graph ID, and signed feedback/access requests.
- Write authority: on-chain identity/payment/escrow/delivery/review/dispute/settlement/anchor events; DKG Agent Profile, Job Agreement, Job Feedback, receipt, dispute reasoning, and Shared Memory `repnet:DisputeCase` writes.
- Curator authority: RepNet does not bypass DKG Context Graph access control. Shared Memory visibility follows the graph participant/peer policy, and clients submit signed intent or feedback rather than forging public reputation Knowledge Assets.
- Private-data boundary: private agreement details, delivery payloads, and raw dispute evidence stay out of public feedback and Shared Memory. Published packages do not use install scripts, dynamic remote code loading, or eval on remote input; production dependency audit is clean.

## Demo plan

The demo path uses short side-by-side recordings so reviewers can see both parties and the resulting memory trail without watching separate Contractor and Worker walkthroughs.

### Demo 1 — Agent onboarding

Status: recorded

Video: [Agent onboarding demo](assets/demos/agent-onboarding.mp4)

Shows a fresh agent creating and registering its RepNet identity.

### Demo 2 — Regular job, Contractor and Worker side by side

Status: pending OriginTrail team resolution of the KA upload/finality issue

Link: [REGULAR_JOB_DEMO_LINK_HERE]

Shows a successful job from both sides: Contractor evaluates/selects the Worker, the Worker accepts and delivers, both parties submit role-aware feedback, and RepNet produces reusable reputation evidence.

### Demo 3 — Disputed escrow, Contractor and Worker side by side

Status: pending OriginTrail team resolution of the KA upload/finality issue

Link: [DISPUTE_SETTLEMENT_DEMO_LINK_HERE]

Shows an escrow job with mixed outcomes: delivery, accepted work, challenged work, Worker response, LLM judge settlement, partial payout/refund/collateral handling, Shared Memory dispute case, and final reputation trail.

## Maintainer commitment

RepNet Protocol will maintain the integration for at least one year after registry acceptance, including compatibility fixes for DKG v10 public interfaces, package security updates, and documentation updates for the MCP server, SDK, CLI, and framework adapters.
