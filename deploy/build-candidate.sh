#!/bin/sh
set -eu

destination=${1:?usage: build-candidate.sh DESTINATION}
test -z "$(git status --porcelain)"
revision=$(git rev-parse HEAD)
epoch=$(git show -s --format=%ct HEAD)
export SOURCE_DATE_EPOCH=$epoch
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/root/wheels" "$stage/root/web"
builder_python=${PYTHON:-python3}
"$builder_python" -m pip wheel . --no-deps --wheel-dir "$stage/root/wheels"
"$builder_python" -m pip download --only-binary=:all: --dest "$stage/root/wheels" \
  'PyYAML==6.0.3' 'cryptography==50.0.1' 'cbor2==6.1.4' \
  'cffi==2.1.1' 'pycparser==3.0'
"$builder_python" -m pip download --only-binary=:all: --dest "$stage/root/wheels" \
  --python-version 310 --implementation cp --abi cp310 \
  --platform manylinux_2_35_x86_64 --platform manylinux_2_34_x86_64 \
  --platform manylinux_2_28_x86_64 --platform manylinux2014_x86_64 \
  'PyYAML==6.0.3' 'cryptography==50.0.1' 'cbor2==6.1.4' \
  'cffi==2.1.1' 'pycparser==3.0' 'typing-extensions==4.15.0'

node_version=24.13.0
node_archive="node-v${node_version}-linux-x64.tar.xz"
node_sha=e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e
mkdir -p "$stage/root/runtime"
curl -fsSLo "$stage/$node_archive" "https://nodejs.org/dist/v${node_version}/$node_archive"
printf '%s  %s\n' "$node_sha" "$stage/$node_archive" | sha256sum -c -
tar -xJf "$stage/$node_archive" -C "$stage/root/runtime"
npm run build --prefix web
cp web/package.json web/package-lock.json "$stage/root/web/"
npm ci --omit=dev --prefix "$stage/root/web"
cp -R web/dist web/public web/scripts "$stage/root/web/"
cp -R deploy docs examples "$stage/root/"
cp README.md ARCHITECTURE.md INVARIANTS.md PROVENANCE.md ROADMAP.md LICENSE-MIT LICENSE-APACHE "$stage/root/"
find "$stage/root" -type d -name __pycache__ -prune -exec rm -rf {} +
find "$stage/root" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete
printf '%s\n' "$revision" > "$stage/root/SOURCE_REVISION"

mkdir -p "$destination"
artifact="$destination/atproto-acl-$revision.tar"
tar --sort=name --mtime="@$epoch" --owner=0 --group=0 --numeric-owner -C "$stage/root" -cf "$artifact" .
gzip -n "$artifact"
sha256sum "$artifact.gz" > "$artifact.gz.sha256"
