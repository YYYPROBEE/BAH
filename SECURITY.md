# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Use GitHub's
**Security → Advisories → Report a vulnerability** on this repository
(<https://github.com/YYYPROBEE/BAH/security/advisories/new>). Please include:

- affected version / commit;
- a minimal reproduction;
- impact assessment and any suggested fix.

We aim to acknowledge reports within 7 days. This is a community-maintained
project without a paid security team; there is no bug bounty.

## Scope

In scope: the BAH host, runtime, bank tools, safety/sentry plane, persistence
audit chain, Web channel, and the RAG sidecar in `services/rag`.

Out of scope for this prototype: findings that require a compromised local
machine, a malicious operator with the model key, or physical access; the
demonstration bank core and verification channels are mocks by design.

## Supported versions

`main` is the only supported line. Tagged releases (`v1.0.x`) receive security
fixes; older tags do not.

## Known boundaries (not vulnerabilities by themselves)

These are deliberate trade-offs of a reference implementation, documented so
that reports can focus on real gaps:

- The Web credential is a per-process Bearer token (or a `password` login with
  scrypt + HttpOnly session, depending on `auth.mode`), not a full identity
  system. One process serves one tenant by design (ADR-0004); session, audit,
  memory and HALT state are all partitioned per tenant on disk.
- The bank ledger is in memory and resets when the process restarts.
- Face / SMS / U-shield verification providers are mocks.
- Audit-chain signing is optional; an unsigned chain is reported as
  `unsigned`, not as verified.
- RAG response signing is not implemented; HALT and tool output contracts
  are implemented. See `docs/security-design.md`.

## Handling of secrets

No credentials are committed to this repository. Model keys are read from the
environment (`BAH_MODEL_KEY` / `DEEPSEEK_API_KEY`), and `.env*` files are
git-ignored except `.env.example`. The knowledge-fixture signing key used in CI
(`demo-key-not-for-prod`) is a public, non-secret test key; production
deployments must re-sign with their own key.
