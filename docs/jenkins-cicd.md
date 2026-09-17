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
| Docker Hub repo | `deep2553/roadmap-ai` |
| Docker Hub credential | Jenkins credential ID `dockerhub-deep2553` (username + PAT) |
| Job | `http://localhost:8080/job/roadmap-ai/` |

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

2. **Store the credentials and create the job.** `scripts/setup-jenkins.sh`
   does both through the Jenkins REST API, reading each secret from a file so
   that no secret lands on a command line (where `ps` exposes it to every user
   on the host) or in the script's output:

   ```bash
   umask 077
   printf '%s' '<jenkins admin password>' > ~/.jenkins-admin.pw
   printf '%s' '<docker hub PAT>'         > ~/.dockerhub.pat
   printf '%s' '<github PAT>'             > ~/.github.pat
   chmod 600 ~/.jenkins-admin.pw ~/.dockerhub.pat ~/.github.pat

   scripts/setup-jenkins.sh ~/.jenkins-admin.pw ~/.dockerhub.pat ~/.github.pat [branch]
   ```

   Prefix those `printf` lines with a space (`HISTCONTROL=ignorespace`, the
   default on most distros) to keep them out of your shell history, then
   `shred -u` all three once the script has run — Jenkins keeps its own
   encrypted copies and the pipeline never reads these files again.

   It stores two username/password credentials in the **Jenkins credential
   store** (never in this repo):

   | Credential ID | Username | Secret | Used by |
   |---|---|---|---|
   | `dockerhub-deep2553` | `deep2553` | Docker Hub PAT | `Push image` / `Promote :latest`, bound as `DH_USER` + `DH_TOKEN` |
   | `github-deep2553` | `Deep2553` | GitHub PAT | The job's SCM checkout |

   The pipeline reads the Docker Hub pair with
   `withCredentials([usernamePassword(credentialsId: env.REGISTRY_CREDS,
   usernameVariable: 'DH_USER', passwordVariable: 'DH_TOKEN')])`, so the values
   exist only as environment variables inside those two stages, are masked in the
   build log by Jenkins, and reach `docker login` through `--password-stdin`.

   The script is idempotent — rerunning updates the existing credentials and job
   config — and takes an optional branch argument (default `main`) so you can
   build a feature branch before merging.

3. **Run one build manually** (`Build Now`). Jenkins only reads the
   `triggers { pollSCM(...) }` block out of the `Jenkinsfile` after it has
   checked the repo out once, so polling does not start until the first build
   has run.

The job checks out with the stored `github-deep2553` credential, so it keeps
working if the repo is ever made private.

## Stages

| Stage | What it does |
|---|---|
| Preflight | Fails fast if Jenkins cannot reach the Docker daemon, if `curl`/`openssl` are missing, or if `$JENKINS_HOME` is unset; logs the commit being built |
| Build CI image | `docker build --target builder` — full source + devDependencies, `next build` already run |
| Verify | `npm run lint`, `npm run typecheck`, `npm test` in parallel, each in a throwaway container |
| Build runtime image | Full `Dockerfile` build (standalone runner stage), tagged `$BUILD_NUMBER` only |
| Push image | `docker login` via `--password-stdin`, then pushes `deep2553/roadmap-ai:$BUILD_NUMBER`. Only the numbered tag — `:latest` waits for the smoke test |
| Prepare runtime secrets | Generates `AUTH_SECRET` and the seed admin password on first build only, into 0600 files outside the workspace |
| Migrate database | Stops the old container, runs `db:migrate` against the volume, then `db:seed` (which self-skips on an already-seeded DB), then `chown`s the data to uid 1001 |
| Deploy | Replaces the running container from the tag just pushed, publishing `127.0.0.1:3100:3000` with the data volume mounted |
| Smoke test | Polls `/` for a 200, then `/api/auth/csrf` (catches a missing or broken `AUTH_SECRET`, which only 500s on auth routes), then `/tracks/devops` (catches a database that migrated but never seeded) |
| Promote :latest | Reached only when the smoke test passed: tags `:latest` locally and pushes `deep2553/roadmap-ai:latest` |

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

There is no automatic rollback. Deploy removes the old container before starting
the new one, so a failed `docker run` leaves nothing serving, and a failed smoke
test leaves the new (broken) container running. Both `roadmap-ai:latest` locally
and `deep2553/roadmap-ai:latest` on Docker Hub always name the last build that
passed its smoke test, so those are the tags to roll back to:

```bash
docker rm -f roadmap-ai-app
docker run -d --name roadmap-ai-app --restart unless-stopped \
  -p 127.0.0.1:3100:3000 --env-file /var/lib/jenkins/roadmap-ai/.env.production \
  -e SQLITE_PATH=/data/sqlite.db -v roadmap-ai-data:/data \
  deep2553/roadmap-ai:latest
```

Any earlier build is `deep2553/roadmap-ai:<build number>`.

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

The **Docker Hub PAT** is not in either file — it lives in Jenkins' own
credential store under the ID `dockerhub-deep2553`, bound into the two stages
that need it with `withCredentials`. Jenkins masks bound credentials in the build
log, and the stages additionally `set +x` and pipe the token through
`docker login --password-stdin` rather than passing it as an argument, where it
would be visible in `ps` to every user on the host. `post { always }` runs
`docker logout` so the credential does not linger in the agent's
`~/.docker/config.json`.

Neither generated value is ever echoed. The `Prepare runtime secrets` stage starts with
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
| Jenkins REST POST returns 403 "No valid crumb" | The crumb is bound to the HTTP session — send the crumb *and* the same cookie jar (`curl -b jar -c jar`) |
| A form POST returns 302 and you assume it failed | Jenkins answers a successful form submit with a redirect; verify by reading the object back, not by the status code |
| `/credential/<id>/updateSubmit` returns 500 | It wants a different, form-shaped payload than `createCredentials`; delete and recreate instead (what the script does) |

## Relationship to the other pipelines

- **Vercel** (`main` → production) is untouched by this. GitHub Actions
  (`.github/workflows/`) still gate PRs.
- **AWS/EC2** (`docs/aws-runbook.md`) is a separate, currently torn-down target
  that uses the same `Dockerfile` via `docker-compose.yml`.
