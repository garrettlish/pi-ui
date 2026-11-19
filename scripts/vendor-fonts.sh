#!/usr/bin/env bash
# Regenerate public/vendor/fonts/ from the Google Fonts CDN.
#
# The two faces are checked in rather than linked from fonts.googleapis.com so
# that the UI keeps its typography on a machine with no route to the internet —
# the same reason prism.min.js is vendored. They are the *variable* builds: one
# file per family covers every weight the stylesheet asks for (Inter 100..900,
# Space Grotesk 300..700), so a fourth weight costs no extra request.
#
# font-display: swap is declared in style.css, not here, because the @font-face
# rules live beside the tokens they feed. Run this only to bump a version.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="public/vendor/fonts"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
# Ask for the full variable range so Google serves the variable build, and for
# only the two subsets this UI needs: latin, and latin-ext for accented names.
CSS_URL="https://fonts.googleapis.com/css2?family=Inter:wght@100..900&family=Space+Grotesk:wght@300..700&display=swap"

mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -sS -m 60 -A "$UA" "$CSS_URL" -o "$TMP/fonts.css"

# Pull the latin and latin-ext source URL for one family out of the CSS. The
# subset is identified by the unicode-range that precedes each @font-face.
pick() { # $1 = family, $2 = "latin" | "latin-ext"
  awk -v fam="$1" -v want="$2" '
    /font-family:/ { f = $0 }
    /src:/ { s = $0 }
    /unicode-range:/ {
      if (f ~ fam) {
        if (want == "latin"   && $0 ~ /U\+0000-00FF/) print s
        if (want == "latin-ext" && $0 ~ /U\+0100-02BA/) print s
      }
    }
  ' "$TMP/fonts.css" | head -1 |
    sed -E 's/.*url\((https:[^)]+)\).*/\1/'
}

fetch() { # $1 = url, $2 = output name
  if [ -z "$1" ]; then echo "no source URL for $2" >&2; exit 1; fi
  curl -sS -m 60 -o "$OUT/$2" "$1"
  # a CDN error page would otherwise be committed as a "font"
  file "$OUT/$2" | grep -q "Web Open Font Format" || {
    echo "$2 is not a WOFF2 file" >&2; rm -f "$OUT/$2"; exit 1; }
}

fetch "$(pick "Inter" "latin")"          inter-latin.woff2
fetch "$(pick "Inter" "latin-ext")"      inter-latin-ext.woff2
fetch "$(pick "Space Grotesk" "latin")"  space-grotesk-latin.woff2
fetch "$(pick "Space Grotesk" "latin-ext")" space-grotesk-latin-ext.woff2

cat > "$OUT/LICENSE" <<'LICENSE'
Inter and Space Grotesk are licensed under the SIL Open Font License, Version 1.1.

Inter — (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)
Space Grotesk — (c) 2018 The Space Grotesk Project Authors
  (https://github.com/floriankarsten/space-grotesk)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
The full license text is available at https://openfontlicense.org

Both files here are the unmodified WOFF2 builds served by Google Fonts
(variable weight axis), fetched by scripts/vendor-fonts.sh.
LICENSE

for f in "$OUT"/*.woff2; do
  printf '%8s  %s\n' "$(wc -c < "$f")" "${f#$OUT/}"
done
echo "wrote $OUT ($(cat "$OUT"/*.woff2 | wc -c | tr -d ' ') bytes total)"
