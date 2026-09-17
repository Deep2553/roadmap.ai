# TWS Roadmaps

A learning-roadmap website: admins build tracks (Subjects → Milestones → Topics/Subtopics) like DevOps or Cloud Engineering, and learners create an account, follow the trail, and check off milestones as they complete them.

Built with Next.js App Router, TypeScript, Tailwind v4 + shadcn/ui, Drizzle ORM (SQLite locally, Turso in production), and Auth.js.

## Getting started

```bash
npm install
cp .env.example .env.local   # then set AUTH_SECRET (the file shows the one-liner)
npm run db:migrate
npm run db:seed              # creates sample DevOps + Cloud Engineering tracks and an admin user
npm run dev
```

Seed admin login defaults to `admin@roadmap.ai` / `ChangeMe123!` (override via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` in `.env.local` before seeding).

- Public site: http://localhost:3000
- Admin: http://localhost:3000/admin/login
- Learner signup: http://localhost:3000/signup

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `npm run start` | Production build / serve |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit tests |
| `npm run test:e2e` | Playwright smoke tests |
| `npm run db:generate` | Generate a Drizzle migration from `lib/db/schema.ts` |
| `npm run db:migrate` | Apply migrations to the local SQLite file |
| `npm run db:seed` | Seed sample tracks + admin user |
| `npm run db:studio` | Open Drizzle Studio |

## Database: local vs. production

`lib/db/client.ts` picks the driver based on env: if `TURSO_DATABASE_URL` is set it connects to Turso (libSQL), otherwise it opens a local SQLite file at `SQLITE_PATH` (default `sqlite.db`). Same schema, same queries — only the connection changes.

## Deployment

- **Live**: https://roadmap-ai-neon.vercel.app (primary, production)
- **Database**: Turso (libSQL), project `roadmap-ai` — migrated and seeded with the sample tracks + an admin account.
- **Repo**: https://github.com/LondheShubham153/roadmap.ai
- **CI**: GitHub Actions runs on every PR/push to `main`:
  - `.github/workflows/lint.yml` — ESLint + `tsc --noEmit`
  - `.github/workflows/ci.yml` — Vitest unit tests + production build

Deploys are handled by Vercel's native GitHub integration (connect it once in the Vercel dashboard — Project Settings → Git — and every push to `main` deploys automatically). Production env vars (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`) are set on the Vercel project — check the dashboard for current values, never print them to a terminal or chat.

`next.config.ts`'s `output` is conditional on `process.env.VERCEL`: Vercel gets its normal build output, and only the self-hosted Docker build (below) gets `"standalone"`. Don't remove that condition — `output: "standalone"` unconditionally breaks every Vercel build (`ENOENT: .next/next-server.js.nft.json`).

### Self-hosted (Docker / AWS EC2) — Phase 2, currently torn down

`Dockerfile` + `docker-compose.yml` at the repo root run this as a single self-hosted container (Turso stays the database either way). `infra/aws/` has a Terraform module that provisions one EC2 instance for this — it was stood up, verified working, and then `terraform destroy`'d once the exercise was done, so nothing is running or billing on AWS right now. See `docs/AWS_DEPLOYMENT_PLAN.md` and `docs/aws-runbook.md` for the full setup and a "Phase 2.1" note on pushing images to a registry instead of building on the host.

## Security

- **Headers**: CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and no `X-Powered-By` — configured in `next.config.ts`.
- **Rate limiting, two layers**:
  1. App-level (`lib/rate-limit.ts`, in-memory, per-instance): `/login`, `/admin/login` (5/min per IP+email, 10/min per IP), `/signup` (5/hour per IP).
  2. Edge-level (Vercel Firewall, dashboard/CLI-managed — not represented in repo files): a custom rule rate-limits `POST /login` and `POST /admin/login` to 10 req/60s per IP. The account's plan allows only one custom rate-limit rule, so `/signup` is covered by the app-level layer only; revisit if the plan changes.
- **Auth**: Auth.js v5, credentials provider, bcrypt-hashed passwords, JWT sessions, `trustHost: true` (needed for any non-Vercel target; harmless on Vercel, which auto-trusts its own host regardless).
- **No account-existence leak**: signup returns a generic error whether or not an email is already registered.
- Full audit trail and reasoning: see the security-hardening PRs on the repo (headers/rate-limiting/signup fix, and the earlier admin-login redirect-loop and `UntrustedHost` fixes).
- **Secrets discipline**: never print a password, token, or key to a terminal or chat — write it to a local gitignored file (e.g. `.admin-credentials.local`, already ignored) if it needs to be handed off. This project has had a real credential leak once already; don't repeat it.

## Sub-agents (parallel dev workflow)

`.claude/agents/` defines four single-purpose agents — `code-reviewer`, `linter`, `unit-tester`, `e2e-tester` — with no overlapping concerns, so they can run **in parallel** instead of one after another. Run `/pre-pr` before opening a pull request to fire all four at once against your current changes.

## Contributing

Never push directly to `main` — branch, open a PR, wait for CI (lint + test/build) and review, then merge. This applies to every change, including small fixes.
