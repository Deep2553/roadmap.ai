# Jenkins CI/CD Runbook

Pipeline definition: `Jenkinsfile` (declarative). It builds, verifies, migrates and
deploys TWS Roadmaps as a Docker container **on the same host that runs Jenkins** —
a local/self-hosted target, separate from the Vercel production deployment (which
stays on Vercel's native Git integration and is unaffected by this pipeline).

| Thing | Where |
|---|---|
| Jenkins | `http://localhost:8080` |
| App (after a successful build) | `http://localhost:3100` (loopback only) |
| Container | `roadmap-ai-app` |
| Data volume | `roadmap-ai-data` (holds `sqlite.db`) |
| Runtime env file | `$JENKINS_HOME/roadmap-ai/.env.production`, mode 0600 |
| Seed admin credentials | `$JENKINS_HOME/roadmap-ai/.admin-credentials`, mode 0600 |

## Why everything runs in a container

The `jenkins` system user has no Node.js — the only Node on this host is under
`admin1`'s nvm, which `jenkins` cannot read. Rather than installing a second Node
for Jenkins, every stage that needs Node runs `docker run` against an image built
from this repo's `Dockerfile`. That also solves `better-sqlite3`, which needs
`python3 make g++` to compile (the `deps` stage installs them) and breaks on
Alpine/musl.

## One-time host setup

This pipeline assumes Jenkins runs as a **service on the host** — it publishes the
app on `127.0.0.1:3100` and then curls that port itself, and it writes secrets to
`$JENKINS_HOME`, expecting that to be a path on the same machine. A containerised
Jenkins breaks both assumptions (its `localhost` is not the host's, and
`$JENKINS_HOME` is inside the container): you would need to mount the Docker
socket, publish the app on a network both containers share, and point the smoke
test at that address instead.

1. **Give Jenkins access to the Docker socket.** Without this the `Preflight`
   stage fails immediately (by design — it prints this same command):

   ```bash
   sudo usermod -aG docker jenkins
   sudo systemctl restart jenkins
   ```

2. **Create the job.** Jenkins → New Item → *Pipeline*:
   - Pipeline → Definition: **Pipeline script from SCM**
   - SCM: Git, Repository URL `https://github.com/LondheShubham153/roadmap.ai`
     (or the local path `/home/admin1/Documents/roadmap.ai` for a workspace-local
     job — note `jenkins` needs read access to it)
   - Branch: `*/main`
   - Script Path: `Jenkinsfile`
   - Save, then **Build Now** once. The `triggers` block in the `Jenkinsfile` only
     takes effect after the first build has run and Jenkins has read the file.

No credentials are needed for a public repo. For a private one, add a GitHub PAT
as a Jenkins credential and select it in the SCM section — never inline it in the
`Jenkinsfile`.

## Stages

| Stage | What it does |
|---|---|
| Preflight | Fails fast if Jenkins cannot reach the Docker daemon, if `curl`/`openssl` are missing, or if `$JENKINS_HOME` is unset; logs the commit being built |
| Build CI image | `docker build --target builder` — full source + devDependencies, `next build` already run |
| Verify | `npm run lint`, `npm run typecheck`, `npm test` in parallel, each in a throwaway container |
| Build runtime image | Full `Dockerfile` build (standalone runner stage), tagged `$BUILD_NUMBER` only |
| Prepare runtime secrets | Generates `AUTH_SECRET` and the seed admin password on first build only, into 0600 files outside the workspace |
| Migrate database | Stops the old container, runs `db:migrate` against the volume, then `db:seed` (which self-skips on an already-seeded DB), then `chown`s the data to uid 1001 |
| Deploy | Replaces the running container, publishing `127.0.0.1:3100:3000` with the data volume mounted |
| Smoke test | Polls `/` for a 200, then `/api/auth/csrf` (catches a missing or broken `AUTH_SECRET`, which only 500s on auth routes), then `/tracks/devops` (catches a database that migrated but never seeded). Promotes `:latest` only once all three pass |

`post { always }` drops the per-build `ci-*` tag and reaps old numbered runtime
tags, keeping the three newest; a failure dumps the last 80 container log lines.
It deliberately does **not** run `docker image prune`, which would also delete
unrelated dangling images belonging to everything else on the host.

Two things worth knowing about the ordering: Verify runs *after* the builder image
has already run `next build`, so lint/test feedback arrives after the most
expensive step (the alternative is a second image build). And `tsc --noEmit`
inside that image sees the generated `.next/types/**`, which the GitHub Actions
typecheck does not — so Jenkins is strictly stricter, and a PR that passed CI can
still fail here.

There is no rollback. Deploy removes the old container before starting the new
one, so a failed `docker run` leaves nothing serving, and a failed smoke test
leaves the new (broken) container running. `:latest` always names the last build
that passed its smoke test, so `docker run "$IMAGE:latest"` is the manual way
back.

## Triggering

`pollSCM('H/2 * * * *')` — Jenkins checks the repo every ~2 minutes. GitHub
webhooks cannot reach `localhost`, so polling is the default. To switch to a
webhook, expose Jenkins through a tunnel (e.g. `ngrok http 8080`), add
`<tunnel>/github-webhook/` under GitHub → Settings → Webhooks, replace the
`triggers` block with `githubPush()`, and enable "GitHub hook trigger for
GITScm polling" on the job.

## Secrets

Both secrets are generated **once**, on the first build, into files under
`$JENKINS_HOME/roadmap-ai/` (`umask 077`, `chmod 600`, directory `chmod 700`) —
outside the workspace, so they are never committed and never archived as build
artifacts. Later builds reuse them.

- `.env.production` holds `AUTH_SECRET`. Regenerating it invalidates every JWT
  session and logs all users out.
- `.admin-credentials` holds `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, passed to
  the seed container with `--env-file`. A generated password is used instead of
  the default documented in `README.md`, so a fresh deploy doesn't come up with a
  publicly known admin login.

Neither value is ever echoed. The `Prepare runtime secrets` stage starts with
`set +x` for this reason: Jenkins runs `sh` steps as `/bin/sh -xe`, and that trace
would otherwise print each expanded command — including the generated secrets —
straight into the build console. Keep `set +x` at the top of any stage that
handles a secret, and pass secrets to containers via `--env-file`, never as
`-e KEY=value` on a command line.

To read the admin login after the first build:

```bash
# $JENKINS_HOME is not set in your shell — use the literal path:
sudo cat /var/lib/jenkins/roadmap-ai/.admin-credentials
```

To rotate either one, delete the file — the next build regenerates it (rotating
the admin password also needs the database reset below, since seeding only runs on
an empty volume):

```bash
sudo rm /var/lib/jenkins/roadmap-ai/.env.production     # new AUTH_SECRET next build
sudo rm /var/lib/jenkins/roadmap-ai/.admin-credentials  # new admin password next build
```

A regenerated admin password only takes effect on a database that gets seeded, so
to actually apply it you also need the database reset below (or change the
password from the app instead).

## Database lifecycle

The SQLite file lives in the named volume `roadmap-ai-data`, so it survives
container replacement and image rebuilds. `lib/db/client.ts` reads `SQLITE_PATH`,
which the pipeline sets to `/data/sqlite.db`.

The pipeline runs `db:seed` on every build; `lib/db/seed.ts` exits early when the
users table already has rows, so it is a no-op on an existing database. (It used
to insert the admin unconditionally and fail with a unique-constraint error on a
second run — hence this change.) After migrating, the pipeline `chown`s `/data` to
uid 1001 — the non-root `nextjs` user the runner stage creates — or the app cannot
write the DB.

To start from scratch (**destroys all local data**):

```bash
docker rm -f roadmap-ai-app
docker volume rm roadmap-ai-data
```

The next build recreates and reseeds it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Preflight: "Jenkins cannot talk to the Docker daemon" | `jenkins` not in the `docker` group — see one-time setup |
| `npm test` finds no test files | `tests/` was excluded in `.dockerignore`; it must stay in the build context |
| App has no tracks, `/tracks/devops` 404s | Database migrated but never seeded — the smoke test catches this; reset the volume below |
| Auth routes 500, landing page fine | `AUTH_SECRET` missing from the env file — delete it and rebuild |
| Can't log in as admin | Password is in `.admin-credentials`, not the README default |
| `SQLITE_READONLY` / cannot write DB | `/data` not owned by uid 1001 |
| Build fails fetching Debian packages | A dropped download in the `deps` stage. The Dockerfile sets `Acquire::Retries=5`; on a very slow link the ~73MB of build-tool packages can still time out — rebuild, the layer cache keeps the rest |
| Port 3100 already in use | A stale container or another service; `docker ps` then `docker rm -f` |

## Relationship to the other pipelines

- **Vercel** (`main` → production) is untouched by this. GitHub Actions
  (`.github/workflows/`) still gate PRs.
- **AWS/EC2** (`docs/aws-runbook.md`) is a separate, currently torn-down target
  that uses the same `Dockerfile` via `docker-compose.yml`.
