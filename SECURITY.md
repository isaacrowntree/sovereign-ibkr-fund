# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Use GitHub's **"Report a vulnerability"** (Security → Advisories) on this repo, or
- email the maintainer.

You'll get an acknowledgement, and we'll coordinate a fix and disclosure timeline
with you.

## Scope & handling money

Sovereign places **real trades** through [bezant](https://github.com/isaacrowntree/bezant).
Take special care with anything that:

- bypasses the execution caps (`MAX_ORDER_NOTIONAL_USD`, `MAX_ORDER_PCT_NAV`,
  `MAX_RUN_NOTIONAL_USD`) or the data-sanity gates,
- affects order idempotency / fill reconciliation, or
- could leak credentials or a real portfolio.

## Secrets

No secrets or personal data live in this repo. Credentials are supplied at
runtime via environment variables (see `.env.example`); the real portfolio is a
gitignored `src/portfolios/local.ts`. If you find a secret committed anywhere in
history, report it privately so it can be rotated.
