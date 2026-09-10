#!/bin/sh
set -eu

artifact=${1:?usage: test-candidate.sh CANDIDATE_TARBALL}
test -f "$artifact"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
tar -xzf "$artifact" -C "$stage"
"$stage/deploy/prepare-release.sh" "$stage"

node="$stage/runtime/node-v24.13.0-linux-x64/bin/node"
python="$stage/venv/bin/python"
test -x "$node"
test -x "$python"

export ATPROTO_ACL_ORIGIN=http://127.0.0.1:8426
export ATPROTO_ACL_FIXTURE_MODE=1
export ATPROTO_ACL_WORKER=0
export ATPROTO_ACL_SESSION_SECRET=artifact-check-session-secret-at-least-32-bytes
export ATPROTO_ACL_PYTHON="$python"
export ATPROTO_ACL_STARTUP_CHECK=1

ATPROTO_ACL_DATA_DIR="$stage/check-web" "$node" "$stage/web/dist/server.js"
ATPROTO_ACL_DATA_DIR="$stage/check-worker" "$node" "$stage/web/dist/worker-main.js"
unset ATPROTO_ACL_STARTUP_CHECK
ATPROTO_ACL_DATA_DIR="$stage/check-journey" "$node" "$stage/web/dist/artifact-check.js"
