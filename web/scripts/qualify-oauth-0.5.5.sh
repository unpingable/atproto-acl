#!/bin/sh
set -eu

# Qualify the next OAuth client in an isolated tree. This deliberately leaves
# package.json, package-lock.json, and node_modules in the working tree alone.
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
candidate_dir=$(mktemp -d "${TMPDIR:-/tmp}/atproto-acl-oauth-0.5.5.XXXXXX")
trap 'rm -rf "$candidate_dir"' EXIT HUP INT TERM

cp "$source_dir/package.json" "$source_dir/package-lock.json" "$source_dir/tsconfig.json" "$candidate_dir/"
cp -R "$source_dir/src" "$source_dir/test" "$candidate_dir/"
cd "$candidate_dir"
npm install --ignore-scripts --save-exact @atproto/oauth-client-node@0.5.5
npm run build
node --import tsx --test test/admission.test.ts test/feed-exposure.test.ts

installed=$(node -e "process.stdout.write(require('./node_modules/@atproto/oauth-client-node/package.json').version)")
test "$installed" = "0.5.5"
printf 'OAuth client %s passed the isolated build and focused tests.\n' "$installed"
