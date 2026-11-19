#!/bin/sh
# One-time setup: makes .github/workflows/release.yml the trusted publisher of
# every public package, so the workflow publishes without a token or 2FA.
# Run it yourself, logged in to npm (`npm login`): the first request asks for
# 2FA; tick "skip for 5 minutes" so the rest go through. Uses npm 11.15+ through
# npx, whatever npm you have installed. Packages that already have a trusted
# publisher fail with an error; the script goes on with the others.
#
# The trusted publisher expires if the workflow does not publish within 2 days
# of this setup: run it right before a release.
cd "$(dirname "$0")/.." || exit 1
for manifest in packages/*/package.json; do
  name=$(node -p "const p = require('./$manifest'); p.private ? '' : p.name")
  [ -z "$name" ] && continue
  echo "== $name"
  npx -y npm@11 trust github "$name" --file release.yml --repo handsforbots/handsforbots --allow-publish --yes || echo "!! $name failed"
  sleep 2
done
