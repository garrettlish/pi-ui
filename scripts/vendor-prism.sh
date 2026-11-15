#!/usr/bin/env bash
# Regenerate public/vendor/prism.min.js from the prismjs npm package.
#
# Prism is checked in rather than declared as a dependency so that a bare
# checkout still runs with `node server.js`: `npm test` / the UI must not need
# `npm install`. Run this only when adding a grammar or bumping the version.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-1.30.0}"
# the grammars worth shipping: measured against every saved pi session
LANGS="core markup clike css javascript typescript json bash yaml markdown python diff"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack "prismjs@$VERSION" --silent >/dev/null && tar xzf prismjs-*.tgz )

{
  cat <<HEADER
/* Prism $VERSION — vendored, unmodified, concatenated.
 *
 * Core plus the grammars this transcript actually sees: markup/html/xml, css,
 * javascript/js, typescript/ts, json, bash/sh/shell, yaml, markdown/md, python,
 * diff. Counted across every saved pi session: bash 169, json 86, markdown 45,
 * js 14, text 13, typescript 3, css 3, python 3 — the rest are single blocks.
 * diff is 605 bytes and every edit tool result is one, so it earns its place.
 *
 * Why a checked-in file instead of an npm dependency: the repo runs from a bare
 * checkout with \`node server.js\`, and syntax highlighting must not be the one
 * thing that needs \`npm install\`. Regenerate with scripts/vendor-prism.sh.
 *
 * MIT licensed, (c) PrismJS contributors — see public/vendor/prism.LICENSE.
 */
HEADER
  for lang in $LANGS; do
    cat "$TMP/package/components/prism-$lang.min.js"
    echo
  done
} > public/vendor/prism.min.js

cp "$TMP/package/LICENSE" public/vendor/prism.LICENSE
echo "wrote public/vendor/prism.min.js ($(wc -c < public/vendor/prism.min.js) bytes) from prismjs@$VERSION"
