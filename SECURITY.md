# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
**Security → Advisories → Report a vulnerability** on this repository, or contact
the repository owner through the private channel provided in the competition
submission. Please include:

- affected version/commit;
- a minimal reproduction;
- impact assessment and any suggested fix.

## Scope

In scope: the BAH host, runtime, bank tools, safety/sentry plane, persistence
audit chain, Web channel, and the RAG sidecar in `services/rag`.

Out of scope for this prototype: findings that require a compromised local
machine, a malicious operator with the model key, or physical access; the
demonstration bank core and verification channels are mocks by design.

## Supported versions

The competition submission line is the only supported line until further notice.

## Known boundaries (not vulnerabilities by themselves)

- The Web credential is a per-process Bearer token, not a login or an identity
  system; there is no multi-tenancy.
- The bank ledger is in memory and resets when the process restarts.
- Face / SMS / U-shield verification providers are mocks.
- Audit-chain signing is optional; an unsigned chain is reported as
  `unsigned`, not as verified.
- RAG response signing is not implemented; HALT and tool output contracts
  are implemented. See `docs/security-design.md`.
