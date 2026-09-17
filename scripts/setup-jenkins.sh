#!/usr/bin/env bash
# Configures Jenkins for TWS Roadmaps: stores the Docker Hub and GitHub
# credentials in Jenkins' credential store, then creates (or updates) the
# pipeline job that builds this repo's Jenkinsfile.
#
# Every secret is read from a file, never taken as an argument: an argument is
# visible in `ps` to every user on the host, and would end up in shell history.
# The credential payloads are written to 0600 temp files and shredded on exit.
# Nothing here ever echoes a secret.
set -euo pipefail

USAGE="usage: scripts/setup-jenkins.sh <jenkins-password-file> <dockerhub-pat-file> <github-pat-file> [branch]"
PW_FILE="${1:?$USAGE}"
DH_PAT_FILE="${2:?$USAGE}"
GH_PAT_FILE="${3:?$USAGE}"
BRANCH="*/${4:-main}"

JENKINS_URL="http://localhost:8080"
JENKINS_USER="admin"
JOB_NAME="roadmap-ai"
REPO_URL="https://github.com/Deep2553/roadmap.ai.git"

DH_USER="deep2553"
DH_CRED_ID="dockerhub-deep2553"
GH_USER="Deep2553"
GH_CRED_ID="github-deep2553"

for f in "$PW_FILE" "$DH_PAT_FILE" "$GH_PAT_FILE"; do
  [ -s "$f" ] || { echo "ERROR: $f is missing or empty"; exit 1; }
done

TMPDIR_RUN=$(mktemp -d); chmod 700 "$TMPDIR_RUN"
cleanup() {
  find "$TMPDIR_RUN" -type f -exec shred -u {} + 2>/dev/null || true
  rm -rf "$TMPDIR_RUN"
}
trap cleanup EXIT

AUTH="$JENKINS_USER:$(cat "$PW_FILE")"
# Jenkins ties the CSRF crumb to the HTTP session, so every request has to carry
# the same cookie jar as the crumb request — otherwise each POST returns 403
# "No valid crumb was included in the request".
COOKIE_JAR="$TMPDIR_RUN/cookies.txt"
api() { curl -sS -u "$AUTH" -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@"; }

# Jenkins' form endpoints answer a successful submit with a 302 redirect, so the
# status code alone is a poor success signal. Accept 2xx/3xx here and then prove
# the object exists by reading it back, rather than trusting the POST.
expect_submitted() { # http_code what
  case "$1" in
    2??|3??) : ;;
    *) echo "   $2: FAILED (HTTP $1)"; exit 1 ;;
  esac
}

require_exists() { # url what
  local code
  code=$(api -o /dev/null -w '%{http_code}' "$1")
  if [ "$code" = "200" ]; then
    echo "   $2: confirmed present"
  else
    echo "   $2: NOT FOUND after submit (HTTP $code)"; exit 1
  fi
}

echo "== 1. Authenticating to Jenkins =="
CRUMB_JSON=$(api "$JENKINS_URL/crumbIssuer/api/json") || { echo "ERROR: cannot reach $JENKINS_URL"; exit 1; }
printf '%s' "$CRUMB_JSON" | grep -q crumb || { echo "ERROR: authentication failed — check the password file."; exit 1; }
CRUMB=$(printf '%s' "$CRUMB_JSON" | sed -E 's/.*"crumb":"([^"]+)".*/\1/')
CRUMB_FIELD=$(printf '%s' "$CRUMB_JSON" | sed -E 's/.*"crumbRequestField":"([^"]+)".*/\1/')
echo "   ok, authenticated as $JENKINS_USER"

# JSON-escape a secret read from a file, without ever printing it.
json_escape_file() { python3 -c 'import json,sys; sys.stdout.write(json.dumps(open(sys.argv[1]).read().strip())[1:-1])' "$1"; }

store_credential() { # id username secret_file description
  local id="$1" user="$2" secret_file="$3" desc="$4" payload exists http
  payload="$TMPDIR_RUN/$id.json"
  : > "$payload"; chmod 600 "$payload"
  {
    printf 'json={"": "0", "credentials": {'
    printf '"scope": "GLOBAL", "id": "%s", "username": "%s", ' "$id" "$user"
    printf '"password": "%s", ' "$(json_escape_file "$secret_file")"
    printf '"description": "%s", ' "$desc"
    printf '"$class": "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl"}}'
  } > "$payload"

  # Replace rather than update: /updateSubmit expects a different, form-shaped
  # payload than /createCredentials and answers this one with a 500. Deleting
  # first keeps the script idempotent with one payload format.
  exists=$(api -o /dev/null -w '%{http_code}' \
    "$JENKINS_URL/credentials/store/system/domain/_/credential/$id/api/json")
  if [ "$exists" = "200" ]; then
    http=$(api -o /dev/null -w '%{http_code}' -X POST -H "$CRUMB_FIELD: $CRUMB" \
      "$JENKINS_URL/credentials/store/system/domain/_/credential/$id/doDelete")
    expect_submitted "$http" "$id delete-before-replace"
  fi
  http=$(api -o /dev/null -w '%{http_code}' -X POST -H "$CRUMB_FIELD: $CRUMB" \
    --data-binary "@$payload" \
    "$JENKINS_URL/credentials/store/system/domain/_/createCredentials")
  expect_submitted "$http" "$id create"
  require_exists "$JENKINS_URL/credentials/store/system/domain/_/credential/$id/api/json" "$id"
}

echo "== 2. Storing credentials (username + password/PAT pairs) =="
store_credential "$DH_CRED_ID" "$DH_USER" "$DH_PAT_FILE" "Docker Hub PAT for pushing $DH_USER/roadmap-ai"
store_credential "$GH_CRED_ID" "$GH_USER" "$GH_PAT_FILE" "GitHub PAT for cloning Deep2553/roadmap.ai"

echo "== 3. Pipeline job ($JOB_NAME), branch ${BRANCH#\*/} =="
JOB_XML="$TMPDIR_RUN/job.xml"
cat > "$JOB_XML" <<XML
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>TWS Roadmaps — build, verify, push to Docker Hub, redeploy locally. Pipeline lives in the repo's Jenkinsfile.</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>$REPO_URL</url>
          <credentialsId>$GH_CRED_ID</credentialsId>
        </hudson.plugins.git.UserRemoteConfig>
      </userRemoteConfigs>
      <branches>
        <hudson.plugins.git.BranchSpec>
          <name>$BRANCH</name>
        </hudson.plugins.git.BranchSpec>
      </branches>
      <doGenerateSubmoduleConfigurations>false</doGenerateSubmoduleConfigurations>
      <submoduleCfg class="empty-list"/>
      <extensions/>
    </scm>
    <scriptPath>Jenkinsfile</scriptPath>
    <lightweight>false</lightweight>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>
XML

job_exists=$(api -o /dev/null -w '%{http_code}' "$JENKINS_URL/job/$JOB_NAME/api/json")
if [ "$job_exists" = "200" ]; then
  http=$(api -o /dev/null -w '%{http_code}' -X POST -H "$CRUMB_FIELD: $CRUMB" \
    -H 'Content-Type: application/xml' --data-binary "@$JOB_XML" \
    "$JENKINS_URL/job/$JOB_NAME/config.xml")
  expect_submitted "$http" "job update"
else
  http=$(api -o /dev/null -w '%{http_code}' -X POST -H "$CRUMB_FIELD: $CRUMB" \
    -H 'Content-Type: application/xml' --data-binary "@$JOB_XML" \
    "$JENKINS_URL/createItem?name=$JOB_NAME")
  expect_submitted "$http" "job create"
fi

require_exists "$JENKINS_URL/job/$JOB_NAME/api/json" "job $JOB_NAME"

echo "== 4. Result =="
api "$JENKINS_URL/job/$JOB_NAME/api/json" | tr ',' '\n' | grep -E '"(displayName|buildable)"' | sed 's/^/   /' || true
api "$JENKINS_URL/credentials/store/system/domain/_/api/json?tree=credentials\[id\]" \
  | tr ',' '\n' | grep -o '"[a-z0-9-]*"' | grep -v credentials | sed 's/^/   credential: /' || true
echo
echo "Job: $JENKINS_URL/job/$JOB_NAME/"
echo "The Jenkinsfile's own pollSCM trigger only registers after Jenkins has"
echo "checked the repo out once, so the first build must be started manually."
