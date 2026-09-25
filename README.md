# Knit

A daily task hub over Google Sheet trackers. What it does and why: `docs/PRD.md`. Scope and milestones: `docs/SOW.md`. How it is built: `CLAUDE.md`.

## Local setup

Needs Node 22 and pnpm (`npm install -g pnpm`; the exact version is pinned in `package.json`).

```bash
pnpm install
cp .env.example .env.local   # then fill in the values
pnpm dev
```

## Commands

| Command          | Does                                                    |
| ---------------- | ------------------------------------------------------- |
| `pnpm dev`       | Run the app locally                                     |
| `pnpm build`     | Production build                                        |
| `pnpm lint`      | ESLint, Prettier check, and the no-em-dash check        |
| `pnpm format`    | Format everything with Prettier                         |
| `pnpm typecheck` | Generate Next.js route types, then run `tsc`            |
| `pnpm test`      | Unit and fixture tests (Vitest, always in the UTC zone) |

## Deployment

Vercel deployments are switched off in `vercel.json` (`git.deploymentEnabled: false`) until the production deploy in M9. The full runbook arrives in M9 as `docs/RUNBOOK.md`.
