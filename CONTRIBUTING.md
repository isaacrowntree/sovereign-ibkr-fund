# Contributing to Sovereign

Thanks for your interest! Sovereign is the fund layer that runs on top of
[bezant](https://github.com/isaacrowntree/bezant).

## Ground rules

- **Never commit secrets or personal data.** No account numbers, hostnames,
  API tokens, or a real portfolio. The real book belongs in a gitignored
  `src/portfolios/local.ts` — the repo ships only `sample.ts`. CI runs a secret
  scan; PRs that trip it are blocked.
- **Deterministic agents.** The agents are plain TypeScript (`--once` processes),
  no LLM calls. Keep them that way.
- **Safety first.** Anything touching execution must respect the caps and
  data-sanity gates. Don't weaken a guardrail without a test proving why.

## Dev loop

```sh
npm install
npm run typecheck
npm test                 # backtest suites skip until you run `npm run fetch-data`
npm run build
```

- Add tests with changes. Vitest, colocated as `*.test.ts`.
- Match the surrounding style. Keep functions small and named clearly.
- Backtests need data: `npm run fetch-data` (Yahoo Finance, gitignored output).

## Pull requests

1. Branch from `main`.
2. `npm run typecheck && npm test` green.
3. Describe the change and its risk surface (esp. anything near execution).

## License

By contributing you agree your contributions are dual-licensed under
**Apache-2.0 OR MIT**, matching the project.
