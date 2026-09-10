#!/bin/sh
set -eu

release=${1:?usage: prepare-release.sh RELEASE_DIRECTORY}
case "$release" in
  /*) ;;
  *) echo "release directory must be an absolute path" >&2; exit 2 ;;
esac
test -d "$release/wheels"
test ! -e "$release/venv"

host_python=${PYTHON:-python3}
"$host_python" -m venv --copies "$release/venv"
"$release/venv/bin/python" -m pip install --no-index \
  --find-links "$release/wheels" atproto-acl

request='{"command":"health"}'
reply=$(printf '%s\n' "$request" | "$release/venv/bin/python" -m atproto_acl.host_bridge)
printf '%s\n' "$reply" | "$release/venv/bin/python" -c \
  'import json, sys; reply = json.load(sys.stdin); result = reply.get("result", {}); assert reply.get("ok") is True and result.get("bridge_schema") == 1 and result.get("state_schema") == 1 and result.get("package_version") and result.get("python_version")'
