#!/bin/sh
# Render the built static/index.html with the repo's own renderer
# (environment-only page, per docs/MultiServer.md "Server list v2"):
# fills BOOTSTRAP_CONFIG (gameEnv, jwtAudience, turnstile key, gitCommit)
# and the CDN asset placeholders. Reads static/index.html and writes the
# rendered page back via a temp file (never redirect straight onto the input).
set -e
cd "$(dirname "$0")/.."
npx tsx src/server/RenderStaticIndex.ts --environment-only > /tmp/hmh-zerox-index.html
mv /tmp/hmh-zerox-index.html static/index.html
echo "Rendered static/index.html"
grep -o 'jwtAudience: "[^"]*"' static/index.html | head -n 1
grep -o 'gameEnv: "[^"]*"' static/index.html | head -n 1
