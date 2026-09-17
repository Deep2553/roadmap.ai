#!/usr/bin/env bash
# Configures the Jenkins job + Docker Hub credential for TWS Roadmaps.
#
# Reads both secrets from files so that no secret ever appears on a command
# line (visible in `ps` to every user on the host) or in this script's output.
set -euo pipefail

JENKINS_URL="http://localhost:8080"
JENKINS_USER="admin"
USAGE="usage: scripts/setup-jenkins.sh <jenkins-password-file> <dockerhub-pat-file> [branch]"
PW_FILE="${1:?$USAGE}"
PAT_FILE="${2:?$USAGE}"
# Branch Jenkins builds. Override for a trial run against a feature branch
# before the pipeline is merged to main.
BRANCH="*/${3:-main}"
JOB_NAME="roadmap-ai"
REPO_URL="https://github.com/Deep2553/roadmap.ai.git"
DH_USER="deep2553"
CRED_ID="dockerhub-deep2553"

for f in "$PW_FILE" "$PAT_FILE"; do
  [ -s "$f" ] || { echo "ERROR: $f is missing or empty"; exit 1; }
done

AUTH="$JENKINS_USER:$(cat "$PW_FILE")"

api() { curl -sS -u "$AUTH" "$@"; }

echo "== 1. Authenticating =="
CRUMB_JSON=$(api "$JENKINS_URL/crumbIssuer/api/json") || { echo "ERROR: cannot reach Jenkins"; exit 1; }
if ! printf '%s' "$CRUMB_JSON" | grep -q crumb; then
  echo "ERROR: authentication failed (check the password file)."; exit 1
fi
CRUMB=$(printf '%s' "$CRUMB_JSON" | sed -E 's/.*"crumb":"([^"]+)".*/\1/')
CRUMB_FIELD=$(printf '%s' "$CRUMB_JSON" | sed -E 's/.*"crumbRequestField":"([^"]+)".*/\1/')
echo "   authenticated as $JENKINS_USER"

echo "== 2. Docker Hub credential ($CRED_ID) =="
# Payload written to a 0600 file, never passed as an argument.
CRED_PAYLOAD=$(mktemp); chmod 600 "$CRED_PAYLOAD"
JOB_XML=$(mktemp)
# One EXIT trap for both temp files: the payload holds the PAT, so shred it.
trap 'shred -u "$CRED_PAYLOAD" 2>/dev/null || rm -f "$CRED_PAYLOAD"; rm -f "$JOB_XML"' EXIT
{
  printf 'json={"": "0", "credentials": {'
  printf '"scope": "GLOBAL", "id": "%s", "username": "%s", ' "$CRED_ID" "$DH_USER"
  printf '"password": "%s", ' "$(cat "$PAT_FILE")"
  printf '"description": "Docker Hub PAT for pushing %s", ' "deep2553/roadmap-ai"
  printf '"$class": "com.cloudbees.plugins.credentials.impl.UsernamePasswordCredentialsImpl"}}'
} > "$CRED_PAYLOAD"

EXISTS=$(api -o /dev/null -w '%{http_code}' \
  "$JENKINS_URL/credentials/store/system/domain/_/credential/$CRED_ID/api/json")
if [ "$EXISTS" = "200" ]; then
  echo "   credential exists — updating"
  api -X POST -H "$CRUMB_FIELD: $CRUMB" \
    --data-binary "@$CRED_PAYLOAD" \
    "$JENKINS_URL/credentials/store/system/domain/_/credential/$CRED_ID/updateSubmit" \
    -o /dev/null -w '   HTTP %{http_code}\n'
else
  api -X POST -H "$CRUMB_FIELD: $CRUMB" \
    --data-binary "@$CRED_PAYLOAD" \
    "$JENKINS_URL/credentials/store/system/domain/_/createCredentials" \
    -o /dev/null -w '   HTTP %{http_code}\n'
fi

echo "== 3. Pipeline job ($JOB_NAME) =="
cat > "$JOB_XML" <<XML
<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>TWS Roadmaps - build, verify, push to Docker Hub, redeploy locally. Pipeline lives in the repo's Jenkinsfile.</description>
  <keepDependencies>false</keepDependencies>
  <properties/>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsScmFlowDefinition" plugin="workflow-cps">
    <scm class="hudson.plugins.git.GitSCM" plugin="git">
      <configVersion>2</configVersion>
      <userRemoteConfigs>
        <hudson.plugins.git.UserRemoteConfig>
          <url>$REPO_URL</url>
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

JOB_EXISTS=$(api -o /dev/null -w '%{http_code}' "$JENKINS_URL/job/$JOB_NAME/api/json")
if [ "$JOB_EXISTS" = "200" ]; then
  echo "   job exists — updating config"
  api -X POST -H "$CRUMB_FIELD: $CRUMB" -H 'Content-Type: application/xml' \
    --data-binary "@$JOB_XML" "$JENKINS_URL/job/$JOB_NAME/config.xml" \
    -o /dev/null -w '   HTTP %{http_code}\n'
else
  api -X POST -H "$CRUMB_FIELD: $CRUMB" -H 'Content-Type: application/xml' \
    --data-binary "@$JOB_XML" "$JENKINS_URL/createItem?name=$JOB_NAME" \
    -o /dev/null -w '   HTTP %{http_code}\n'
fi

echo "== 4. Verifying =="
api "$JENKINS_URL/job/$JOB_NAME/api/json" \
  | tr ',' '\n' | grep -E '"(name|buildable)"' | sed 's/^/   /' || true
echo
echo "Done. Job: $JENKINS_URL/job/$JOB_NAME/"
echo "The pipeline's own 'triggers { pollSCM(...) }' block only takes effect once"
echo "Jenkins has checked the repo out, so run one build manually now (Build Now)."
