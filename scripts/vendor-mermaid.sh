#!/usr/bin/env bash
# Regenerate public/vendor/mermaid.min.js from the mermaid npm package.
#
# Mermaid is checked in rather than declared as a dependency for the same reason
# Prism is (see scripts/vendor-prism.sh): `node server.js` must work on a bare
# checkout, and a diagram in an answer must not be the one thing that needs
# `npm install`. Unlike Prism it is NOT loaded on every page — app.js injects
# this script only when a transcript actually contains a ```mermaid fence, so a
# session with no diagrams pays nothing for it.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-11.17.2}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$TMP" && npm pack "mermaid@$VERSION" --silent >/dev/null && tar xzf mermaid-*.tgz )

{
  cat <<HEADER
/* Mermaid $VERSION — vendored, unmodified.
 *
 * The UMD build: it assigns globalThis.mermaid and pulls in every renderer
 * (flowchart, sequence, class, state, ER, gantt, pie, …), because an answer
 * that contains a diagram can contain any of them and a per-diagram bundle
 * would mean a network round trip per fence.
 *
 * It is 3.4 MB on disk but ~1 MB gzipped, served from loopback, and fetched on
 * demand — see hydrateMermaid() in public/app.js. Regenerate with
 * scripts/vendor-mermaid.sh.
 *
 * MIT licensed, (c) Knut Sveidqvist and the Mermaid contributors — see
 * public/vendor/mermaid.LICENSE.
 */
HEADER
  cat "$TMP/package/dist/mermaid.min.js"
  echo
} > public/vendor/mermaid.min.js

cp "$TMP/package/LICENSE" public/vendor/mermaid.LICENSE
echo "wrote public/vendor/mermaid.min.js ($(wc -c < public/vendor/mermaid.min.js) bytes) from mermaid@$VERSION"
