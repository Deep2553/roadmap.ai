// CI/CD for TWS Roadmaps on a local Jenkins (localhost:8080).
//
// Every stage that needs Node runs inside a container built from this repo's
// Dockerfile: the `jenkins` system user has no Node installed (the only Node on
// this host is under admin1's nvm), and `better-sqlite3` needs python3/make/g++
// to compile — both of which the Dockerfile's `deps` stage already handles.
//
// Deploys to a container on this host. GitHub webhooks cannot reach localhost,
// so the trigger is SCM polling — see docs/jenkins-cicd.md to switch to a
// webhook if you expose Jenkins through a tunnel.
// Assumes a single-node Jenkins where the controller runs the build: $JENKINS_HOME
// is a path on the same host that serves port $APP_PORT. On a remote agent the
// secret files below would land on the agent instead — Preflight asserts
// $JENKINS_HOME is set, but it cannot detect that case, so don't add agents
// without revisiting this.
pipeline {
  agent any

  options {
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
    // A cold first build compiles better-sqlite3 and runs `next build` twice; on a
    // slow link the apt stage alone can take ~10 minutes.
    timeout(time: 45, unit: 'MINUTES')
  }

  triggers {
    pollSCM('H/2 * * * *')
  }

  environment {
    IMAGE       = 'roadmap-ai'
    CONTAINER   = 'roadmap-ai-app'
    DATA_VOLUME = 'roadmap-ai-data'
    APP_PORT    = '3100'
    // Runtime env lives outside the workspace so it is never archived, never
    // committed, and never printed. Generated once, on the first build.
    ENV_FILE    = "${JENKINS_HOME}/roadmap-ai/.env.production"
    // Seed admin credentials, same treatment. Only the path is ever logged.
    CREDS_FILE  = "${JENKINS_HOME}/roadmap-ai/.admin-credentials"
    // Matches the non-root user the Dockerfile's runner stage creates.
    APP_UID     = '1001'
  }

  stages {
    stage('Preflight') {
      steps {
        sh '''
          set -e
          docker info >/dev/null 2>&1 || {
            echo "Jenkins cannot talk to the Docker daemon."
            echo "Run: sudo usermod -aG docker jenkins && sudo systemctl restart jenkins"
            exit 1
          }
          command -v curl >/dev/null || {
            echo "curl is missing on the Jenkins host — the smoke test needs it."
            exit 1
          }
          command -v openssl >/dev/null || {
            echo "openssl is missing on the Jenkins host — needed to generate AUTH_SECRET."
            exit 1
          }
          # Unset would make Groovy interpolate the literal "null" into ENV_FILE,
          # turning it into a workspace-relative path — i.e. secrets written where
          # the job's workspace browser can serve them.
          [ -n "$JENKINS_HOME" ] || {
            echo "JENKINS_HOME is not set; refusing to guess where to put secrets."
            exit 1
          }
          git --no-pager log -1 --oneline
        '''
      }
    }

    stage('Build CI image') {
      steps {
        sh 'docker build --target builder -t "$IMAGE:ci-$BUILD_NUMBER" .'
      }
    }

    stage('Verify') {
      parallel {
        stage('Lint') {
          steps { sh 'docker run --rm "$IMAGE:ci-$BUILD_NUMBER" npm run lint' }
        }
        stage('Typecheck') {
          steps { sh 'docker run --rm "$IMAGE:ci-$BUILD_NUMBER" npm run typecheck' }
        }
        stage('Unit tests') {
          steps { sh 'docker run --rm "$IMAGE:ci-$BUILD_NUMBER" npm test' }
        }
      }
    }

    stage('Build runtime image') {
      steps {
        // :latest is applied after the smoke test, not here, so that the tag
        // always names a build that actually served traffic.
        sh 'docker build -t "$IMAGE:$BUILD_NUMBER" .'
      }
    }

    stage('Prepare runtime secrets') {
      steps {
        sh '''
          set -e
          # Jenkins runs `sh` steps as `/bin/sh -xe`, which echoes every expanded
          # command — that trace would print the generated secrets straight into
          # the build console. Trace off for the whole stage; nothing here needs it.
          set +x

          mkdir -p "$(dirname "$ENV_FILE")"
          chmod 700 "$(dirname "$ENV_FILE")"
          umask 077

          if [ ! -s "$ENV_FILE" ]; then
            # Generate into a variable and assert it first. Writing
            # "$(openssl ...)" straight into the file would discard openssl's exit
            # status, leaving a non-empty file containing `AUTH_SECRET=` — which
            # every later build would then happily "reuse".
            SECRET="$(openssl rand -base64 32)"
            [ -n "$SECRET" ] || { echo "openssl produced an empty AUTH_SECRET."; exit 1; }
            printf 'AUTH_SECRET=%s\\n' "$SECRET" > "$ENV_FILE"
            unset SECRET
            echo "Generated a fresh AUTH_SECRET at $ENV_FILE (value intentionally not logged)."
          else
            echo "Reusing existing AUTH_SECRET at $ENV_FILE (rotating it logs every user out)."
          fi
          chmod 600 "$ENV_FILE"

          # A generated admin password beats the documented default in README.md,
          # which would otherwise ship on every fresh deploy. Written to a file,
          # never to the console — read it with:
          #   sudo cat $CREDS_FILE
          if [ ! -s "$CREDS_FILE" ]; then
            # An empty password here would seed an admin whose password is "",
            # which bcrypt hashes quite happily — so assert before writing.
            # SEED_ADMIN_EMAIL is deliberately absent: lib/db/seed.ts owns that
            # default, and duplicating it here would let the two drift.
            PW="$(openssl rand -base64 18)"
            [ -n "$PW" ] || { echo "openssl produced an empty admin password."; exit 1; }
            printf 'SEED_ADMIN_PASSWORD=%s\\n' "$PW" > "$CREDS_FILE"
            unset PW
            echo "Generated a seed admin password at $CREDS_FILE (read it there, it is not logged)."
          else
            echo "Reusing the seed admin password at $CREDS_FILE."
          fi
          chmod 600 "$CREDS_FILE"
        '''
      }
    }

    stage('Migrate database') {
      steps {
        sh '''
          set -e
          docker volume create "$DATA_VOLUME" >/dev/null

          # Stop the old container first: it holds the same SQLite file open, and
          # migrating underneath a running app means two writers on one file plus
          # new schema under old code. This starts the deploy's downtime window.
          docker stop "$CONTAINER" >/dev/null 2>&1 || true

          docker run --rm -v "$DATA_VOLUME":/data -e SQLITE_PATH=/data/sqlite.db \
            "$IMAGE:ci-$BUILD_NUMBER" npm run db:migrate

          # Run unconditionally: lib/db/seed.ts exits early when the users table
          # is already populated. The previous file-existence guard
          # (`test -s /data/sqlite.db`) was wrong — migrate creates that file, so
          # a first build that migrated and then failed to seed would leave every
          # later build convinced the database was already seeded, deploying an
          # app with no admin and no tracks while both smoke tests still passed.
          # Credentials go in via --env-file, never as -e on the command line:
          # the -x trace would capture the value.
          docker run --rm -v "$DATA_VOLUME":/data -e SQLITE_PATH=/data/sqlite.db \
            --env-file "$CREDS_FILE" \
            "$IMAGE:ci-$BUILD_NUMBER" npm run db:seed

          # The runner stage runs as uid 1001 and must be able to write the DB.
          # Done with the CI image rather than a pulled alpine:3, to keep the
          # pipeline off Docker Hub (and its rate limits) once the build is done.
          docker run --rm -v "$DATA_VOLUME":/data --user 0:0 \
            "$IMAGE:ci-$BUILD_NUMBER" chown -R "$APP_UID:$APP_UID" /data
        '''
      }
    }

    stage('Deploy') {
      steps {
        sh '''
          set -e
          docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
          # Published on loopback only. A LAN-reachable port here would expose an
          # app with an auto-seeded admin account, and Docker's NAT rules bypass
          # ufw, so a host firewall would not save you.
          docker run -d \
            --name "$CONTAINER" \
            --restart unless-stopped \
            -p "127.0.0.1:$APP_PORT:3000" \
            --env-file "$ENV_FILE" \
            -e SQLITE_PATH=/data/sqlite.db \
            -v "$DATA_VOLUME":/data \
            "$IMAGE:$BUILD_NUMBER"
        '''
      }
    }

    stage('Smoke test') {
      steps {
        sh '''
          set -e
          code=000
          for _ in $(seq 1 30); do
            code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/" || true)
            [ "$code" = "200" ] && break
            sleep 2
          done
          if [ "$code" != "200" ]; then
            echo "Landing page returned $code"
            docker logs --tail 80 "$CONTAINER"
            exit 1
          fi

          # Catches a missing/broken AUTH_SECRET, which 500s only on auth routes.
          auth=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/api/auth/csrf" || true)
          if [ "$auth" != "200" ]; then
            echo "Auth route returned $auth"
            docker logs --tail 80 "$CONTAINER"
            exit 1
          fi

          # A seeded, DB-backed page. The landing page renders fine against an
          # empty database, so without this a failed or skipped seed would ship
          # an app with no tracks and still pass the pipeline. Depends on the
          # `devops` slug from lib/db/seed.ts.
          track=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$APP_PORT/tracks/devops" || true)
          if [ "$track" != "200" ]; then
            echo "Seeded track page /tracks/devops returned $track"
            docker logs --tail 80 "$CONTAINER"
            exit 1
          fi

          # Only now is this build known good, so only now does it get :latest.
          docker tag "$IMAGE:$BUILD_NUMBER" "$IMAGE:latest"
          echo "Build $BUILD_NUMBER live at http://localhost:$APP_PORT"
        '''
      }
    }
  }

  post {
    always {
      sh '''
        docker rmi "$IMAGE:ci-$BUILD_NUMBER" >/dev/null 2>&1 || true
        # Keep the three most recent runtime tags and drop older ones. Scoped to
        # $IMAGE on purpose: a bare `docker image prune` would also delete
        # unrelated dangling images belonging to everything else on this host.
        docker images --format '{{.Repository}}:{{.Tag}}' "$IMAGE" \
          | grep -E ':[0-9]+$' | sort -t: -k2 -rn | tail -n +4 \
          | xargs -r -n1 docker rmi >/dev/null 2>&1 || true
      '''
    }
    failure {
      sh 'docker logs --tail 80 "$CONTAINER" 2>/dev/null || true'
    }
  }
}
