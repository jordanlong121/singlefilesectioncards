#!/usr/bin/env bash
# Cut a BRAT-installable PRERELEASE so phones can test builds without publishing.
#
#   tools/beta-release.sh 1.9.1-beta.1
#
# Builds the working tree, stamps the given version into a copy of manifest.json,
# and uploads main.js + manifest.json + styles.css as a GitHub prerelease. Marked
# prerelease, it is invisible to the community directory's update checks — only
# BRAT users who added this repo see it.
#
# One-time phone setup: install "BRAT" from the community directory, then
# BRAT → Add beta plugin → jordanlong121/singlefilesectioncards (leave
# "latest version" selected, with prereleases enabled). After that, every run of
# this script reaches the phone via BRAT's "Check for updates".
#
# Note: gh tags the repo's HEAD commit, but the uploaded assets come from the
# working tree — commit first if the tag should match what's being tested.
set -euo pipefail

v="${1:?usage: tools/beta-release.sh <version, e.g. 1.9.1-beta.1>}"
cd "$(dirname "$0")/.."

npm run build

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
python3 - "$v" > "$tmp/manifest.json" <<'EOF'
import json, sys
m = json.load(open("manifest.json"))
m["version"] = sys.argv[1]
json.dump(m, sys.stdout, indent="\t", ensure_ascii=False)
EOF
cp main.js styles.css "$tmp/"

gh release create "$v" "$tmp/main.js" "$tmp/manifest.json" "$tmp/styles.css" \
	--prerelease --title "$v" \
	--notes "Mobile test build — install via BRAT: jordanlong121/singlefilesectioncards."

echo "Prerelease $v is up — on the phone: BRAT → Check for updates."
