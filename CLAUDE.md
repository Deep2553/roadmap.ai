@AGENTS.md

# TWS Roadmaps (formerly "Waypoint")

A roadmap.sh-style learning platform. Admins build tracks (**Subjects** → **Milestones/Topics** → **Subtopics**), like DevOps or Cloud Engineering. Learners sign up, follow a visual trail-map roadmap per track, and check off topics to track progress — including a job-readiness percentage broken into Fresher/Intermediate/Expert tiers.

Two-phase project (see `PLAN.md` for the original brief):
- **Phase 1 (done)**: Next.js on Vercel + Turso, GitHub Actions CI.
- **Phase 2 (done)**: rebrand to "TWS Roadmaps", Docker/Terraform/EC2 self-hosted deployment (built, verified, then torn down — see below), pre-launch security hardening.

## Stack

- **Framework**: Next.js 16 (App Router), TypeScript, React 19
- **Styling**: Tailwind CSS v4 + shadcn/ui (custom trail-map visual theme — warm paper/moss/amber palette, Fraunces + IBM Plex fonts)
- **Database**: Drizzle ORM. SQLite locally (`sqlite.db`, via `better-sqlite3`), **Turso** (libSQL) in production. `lib/db/client.ts` auto-switches based on whether `TURSO_DATABASE_URL` is set — same schema/queries either way.
- **Auth**: Auth.js (NextAuth v5), Credentials provider, bcrypt-hashed passwords, JWT sessions, `trustHost: true`. Two roles: `admin` and `learner`, enforced in `proxy.ts` (Next.js 16 renamed `middleware.ts` → `proxy.ts`).
- **Testing**: Vitest (`tests/*.test.ts`, pure-logic unit tests) + Playwright (`e2e/*.spec.ts`, browser smoke tests — not yet run in CI, verified manually via ad hoc scripts during development).
- **Deployment**: Vercel + Turso (primary, live). Docker + Terraform/EC2 (secondary, self-hosted — currently torn down, see below).

## Data model (`lib/db/schema.ts`)

- `users` — id, name, email, passwordHash, role (`admin`|`learner`)
- `subjects` — a track (DevOps, Cloud Engineering), slug/title/description/color
- `topics` — belongs to a subject; `parentTopicId` (self-referencing) allows milestone → subtopic nesting; `level` = tree depth (`milestone`|`topic`|`subtopic`); `careerLevel` = job-readiness tier (`fresher`|`intermediate`|`expert`) — **do not confuse `level` and `careerLevel`, they are unrelated fields**
- `resources` — links attached to a topic (article/video/doc)
- `progress` — join table: which user completed which topic

Readiness math lives in `lib/readiness.ts` (`computeReadiness`) — pure and unit-tested (`tests/readiness.test.ts`). A topic tagged `fresher` counts toward every tier's required-topic set; `expert` only counts toward the expert tier.

## App structure

- `app/(public)/page.tsx` — landing page (`export const dynamic = "force-dynamic"` — see gotcha below)
- `app/tracks/[slug]/page.tsx` — **single shared route** for both public (read-only) and learner (interactive, checkboxes) views of a track — do NOT split this into separate route groups per role, that was tried and caused a routing conflict (two route groups both resolving to `/tracks/[slug]`)
- `app/(auth)/login`, `/signup`, `/admin/login` — auth pages, all client components using `useActionState` against server actions in `app/actions/auth.ts`
- `app/(learner)/dashboard/page.tsx` — per-track progress + readiness breakdown
- `app/(admin)/admin/*` — subject/topic/resource CRUD via server actions in `app/actions/admin.ts`
- `app/actions/*.ts` — server actions (`"use server"`), preferred over API routes for all mutations. Only real API route is `app/api/auth/[...nextauth]/route.ts`.
- `components/roadmap/roadmap-tree.tsx` — the trail-map visual (client component); topics render as a zigzag path; clicking a topic's info button opens a Dialog with description + resources
- `lib/rate-limit.ts` — best-effort in-memory rate limiter (per-instance, not a global guarantee on serverless — documented in the module). Wired into `loginAction`/`signupLearner` in `app/actions/auth.ts`.
- `proxy.ts` — route guard. Matcher is `["/admin/:path*", "/dashboard/:path*"]`. **Known gotcha already hit once**: `/admin/:path*` also matches `/admin/login` itself, so the admin-role check must explicitly exclude `pathname === "/admin/login"` or it infinite-redirect-loops the login page to itself (already fixed — don't reintroduce it).

## Known gotchas (already hit, don't reintroduce)

1. **`/admin/login` self-redirect loop** — see `proxy.ts` above.
2. **Auth.js `UntrustedHost`** — any non-Vercel deployment target (a bare IP, a custom domain without `AUTH_URL` set) needs `trustHost: true` in `lib/auth.ts`, or every `/api/auth/*` request 500s. Already set; don't remove it even after the EC2 target was torn down, since it's harmless on Vercel (which auto-trusts its own host regardless).
3. **`output: "standalone"` breaks Vercel builds.** Next's standalone output mode (needed for the slim Docker image) changes the build's trace output shape in a way that crashes Vercel's own build step (`ENOENT: .next/next-server.js.nft.json`). `next.config.ts` guards this with `process.env.VERCEL ? undefined : "standalone"` — Vercel sets that env var automatically during its builds. Never make `output: "standalone"` unconditional again.
4. **Pages that query the DB at module scope crash the build with no database present** (a fresh CI checkout, a fresh Vercel preview before env vars propagate). Next 16 attempts to statically execute every page during the build's page-data-collection pass regardless of its final runtime classification. Every page reading live admin/learner data (`/`, `/admin`, `/admin/subjects/[id]`, `/dashboard`, `/tracks/[slug]`) has `export const dynamic = "force-dynamic"` for exactly this reason — keep that on any new page that queries the DB directly.
5. **`better-sqlite3` needs a compiler or a glibc host.** The Docker build uses `node:22-slim` (Debian, not Alpine) and installs `python3 make g++` in the deps stage — Alpine/musl breaks the native binding, and there's often no prebuilt binary for arbitrary platform/Node combos.
6. **Vercel's plan allows only one custom Firewall rate-limit rule.** A second `vercel firewall rules add --action rate_limit` call fails with "Rate limiting is not available for this plan (401)" once one exists. The one rule in use covers `POST /login` OR `POST /admin/login` via an OR-group (edited into the existing rule, not created as a second one). `/signup` only has the app-level `lib/rate-limit.ts` limiter, not an edge rule — revisit if the Vercel plan changes.
7. **`.dockerignore` must keep `tests/`.** The Jenkins pipeline runs Vitest inside the `builder` stage, so excluding `tests` there makes `npm test` fail with "No test files found" in CI while passing locally. `e2e/` stays excluded — the image has no browsers. Test files never reach the runner image regardless (it copies only `.next/standalone`, `.next/static`, `public`).

## Conventions

- Server actions over API routes for mutations.
- Pure logic extracted into small testable modules (`lib/slug.ts`, `lib/readiness.ts`, `lib/rate-limit.ts`) separate from the server actions that call them, specifically so they're unit-testable without a DB.
- Drizzle migrations: edit `lib/db/schema.ts`, run `npm run db:generate`, commit the generated SQL under `drizzle/`. Apply with `npm run db:migrate` (local SQLite) or `npx drizzle-kit migrate` with `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` set (production Turso).
- `lib/db/seed.ts` is idempotent — it exits early if the `users` table has any rows, so running it twice is a no-op rather than a `UNIQUE constraint failed: users.email` crash. It seeds sample DevOps + Cloud Engineering tracks and an admin account; DevOps topics carry real TrainWithShubham resources (YouTube channel-search links + trainwithshubham.com) — no fabricated per-topic video URLs.

## Workflow rules (from the user)

- **Never commit directly to `main`.** Always work on a feature branch and open a pull request — even for one-line fixes. The user reviews the PR, GitHub Actions CI runs on it, and only a merge to `main` triggers a Vercel deployment (Vercel's native Git integration, not a custom Action).
- **Never display a password, API token, auth secret, or private key** — not in chat text, not in any Bash/tool output (`echo`, `cat`, plain command substitution). This applies to freshly generated values too, not just pre-existing secrets. If a secret must reach the user, write it to a local file outside git tracking (e.g. `.admin-credentials.local`, gitignored) with `chmod 600` and tell them the path — never paste the value. This is a hard-learned rule: a generated admin password and other secrets were printed to a shared screen once, forcing an emergency rotation of the admin password, `AUTH_SECRET`, and the Turso auth token (Turso only supports invalidating *all* tokens at once via `turso group tokens invalidate <group>`, not one at a time — keep that in mind if this happens again).
- Four project sub-agents live in `.claude/agents/` (`code-reviewer`, `linter`, `unit-tester`, `e2e-tester`) meant to run **in parallel** (one message, multiple `Agent` calls), not sequentially — invoke via the `/pre-pr` command before opening a PR.
- `.claude/commands/pre-pr.md` documents that parallel-invocation convention.

## Deployment details

- **Live URL**: https://roadmap-ai-neon.vercel.app (Vercel project `roadmap-ai`, org `shubham-londhes-projects-2ea14790`)
- **GitHub repo**: https://github.com/LondheShubham153/roadmap.ai (note: repo is named `roadmap.ai` with a dot, local directory is `roadmap-ai` with a hyphen — don't assume they match)
- **Turso DB**: project `roadmap-ai`, region `aws-ap-northeast-1`
- Production env vars (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `AUTH_SECRET`) are set on the Vercel project (production **and** preview environments — preview needs them too, or PR preview deployments 500 on any DB-touching route).
- CI: `.github/workflows/lint.yml` (ESLint + typecheck) and `.github/workflows/ci.yml` (Vitest + build) run on every PR/push to `main`.
- Vercel's native GitHub integration handles deploys once connected in the dashboard (Project → Settings → Git) — there is intentionally no custom GitHub Actions deploy workflow, to avoid double-deploying.
- **AWS/Docker (secondary, currently torn down)**: `Dockerfile`, `docker-compose.yml`, `infra/aws/` (Terraform) exist in the repo and were verified working end-to-end (t2.medium EC2, default VPC, no Elastic IP/domain/TLS). Torn down via `terraform destroy` once verification was complete — nothing running or billing on AWS right now. To bring it back: `docs/aws-runbook.md` has the full sequence. The generated SSH key and `terraform.tfstate` are gitignored and were local-only; a fresh `terraform apply` generates new ones.
- **Local Jenkins CI/CD**: `Jenkinsfile` (root) + `docs/jenkins-cicd.md`. Targets a Jenkins on `localhost:8080` and deploys a container on this host at `127.0.0.1:3100` (loopback only — an auto-seeded admin account should not be LAN-reachable, and Docker's NAT bypasses ufw), DB in the `roadmap-ai-data` Docker volume. Every Node step runs inside a container built from the repo `Dockerfile` — the `jenkins` user has no Node. `AUTH_SECRET` and the seed admin password are generated once into 0600 files under `$JENKINS_HOME/roadmap-ai/` (outside the workspace, never logged — the secret stage runs `set +x` because Jenkins executes `sh` steps as `/bin/sh -xe`, whose trace would otherwise print them). `db:seed` runs every build and self-skips on a populated DB. Trigger is `pollSCM` because GitHub webhooks cannot reach localhost. Requires `jenkins` in the `docker` group (a sudo step the Preflight stage checks for). Independent of Vercel — it never touches production.
- **Vercel Firewall**: one custom rate-limit rule ("Rate limit login") is live, managed via `vercel firewall` CLI/dashboard — **not represented in any repo file**. If auditing security config, check the Vercel dashboard's Firewall tab, not just the codebase.

## Security posture (as of the pre-launch audit)

Confirmed clean: no SQL injection surface (Drizzle everywhere, no raw SQL), no XSS sinks (`dangerouslySetInnerHTML`/`eval` grepped, none found), CSRF-safe server actions (default same-origin, no `allowedOrigins` override), consistent server-side `role === "admin"` checks in every admin action, learner progress actions correctly scoped to `session.user.id` (no IDOR), 0 `npm audit` vulnerabilities, no secrets in committed files.

Hardened during Phase 2 (see `README.md`'s Security section for the current list): security headers (CSP, `X-Frame-Options`, etc.) in `next.config.ts`, two-layer rate limiting on auth routes, no account-existence leak on signup.

## Known issues / possible follow-ups

- `/signup` has no edge-level (Vercel Firewall) rate limit — only the in-app `lib/rate-limit.ts` layer, due to the one-custom-rule plan limit noted above.
- `e2e/*.spec.ts` (Playwright) exist but aren't wired into CI — verification during development has been via ad hoc Playwright scripts run manually, not the checked-in suite.
- `package.json`'s internal `name` field and the seed admin email were left as `roadmap-ai`/`roadmap.ai` intentionally after the TWS Roadmaps rename — internal identifiers, not user-facing branding.
