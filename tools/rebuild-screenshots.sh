#!/usr/bin/env bash
# Rebuild every README screenshot and hero banner from the preview harness, each staged
# the same way every time (notes, env, backgrounds, window sizes), then crop the few that
# are close-ups and compose the heroes. WSL + Windows Chrome (see tools/make_heroes.py
# for the fonts); needs harness-out/app.css (tools/asar-extract.mjs) once.
#   bash tools/rebuild-screenshots.sh            → writes screenshots/*.png
set -euo pipefail
REPO=/home/jlong/obsidian-plugins/single-file-section-cards
WROOT=/mnt/c/Users/Jordan.Long/AppData/Local/Temp/rebuild
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
OUT=$REPO/harness-out/shots
PHOTOS=$REPO/harness-out/photos
rm -rf "$WROOT" "$OUT"; mkdir -p "$WROOT" "$OUT"
cd "$REPO" && node test/run.mjs >/dev/null   # the harness imports test/.tmp/main.js

# The Images shots' royalty-free photos (Unsplash), fetched once into harness-out/photos.
mkdir -p "$PHOTOS"
while read -r name url; do
	[ -s "$PHOTOS/$name" ] || curl -sL --max-time 60 -o "$PHOTOS/$name" "$url"
done <<'EOF'
mountain-ridge.jpg https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1152&h=720&fit=crop&q=80
forest-trail.jpg https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1056&h=672&fit=crop&q=80
lakeside-dock.jpg https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=1056&h=960&fit=crop&q=80
city-skyline.jpg https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1152&h=648&fit=crop&q=80
misty-pines.jpg https://images.unsplash.com/photo-1507041957456-9c397ce39c97?w=800&h=500&fit=crop&q=80
canyon-road.jpg https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?w=800&h=500&fit=crop&q=80
monument-valley.jpg https://images.unsplash.com/photo-1509316785289-025f5b846b35?w=800&h=500&fit=crop&q=80
EOF

stage() { mkdir -p "$WROOT/$1"; cp "$REPO/harness-out/app.css" "$REPO/harness-out/theme.css" "$WROOT/$1/"; }
# shoot <dir> <page> <out-name> <WxH> [extra chrome flags]
shoot() {
	"$CHROME" --headless=new --disable-gpu ${5:-} --screenshot="C:\\Users\\Jordan.Long\\AppData\\Local\\Temp\\rebuild\\$1\\$3.png" \
		--window-size="$4" "file:///C:/Users/Jordan.Long/AppData/Local/Temp/rebuild/$1/$2.html" >/dev/null 2>&1
	cp "$WROOT/$1/$3.png" "$OUT/$3.png"
	echo "  $3"
}
harness() { local dir=$1; shift; env "$@" node "$REPO/tools/preview-harness.mjs" "$WROOT/$dir" >/dev/null; }

echo "default note"
stage def; harness def
for p in grid aligned tight horizontal vertical rolodex custom links hierarchy dividers deck; do shoot def "$p" "$p" 1280,760; done
shoot def tasks tasks 1280,720
shoot def heatmap heatmap-full 1280,760
shoot def context-menu context-menu-full 1280,760
"$CHROME" --headless=new --disable-gpu --dump-dom "file:///C:/Users/Jordan.Long/AppData/Local/Temp/rebuild/def/context-menu.html" 2>/dev/null > "$OUT/context-menu.dom.html"

echo "images (plain, and the hero's on aurora)"
stage img; cp "$PHOTOS"/*.jpg "$WROOT/img/"
IMG="mountain-ridge.jpg,forest-trail.jpg,lakeside-dock.jpg,city-skyline.jpg,monument-valley.jpg,misty-pines.jpg,canyon-road.jpg"
harness img IMAGES="$IMG"; shoot img images images 1280,760
harness img IMAGES="$IMG" BG=bg-aurora; shoot img images images-full 1280,760

echo "brainstorm"
stage bs
harness bs NOTE="$REPO/sample-vault/Brainstorm.md" LEVEL=3 SORT=doc BG=bg-aurora; shoot bs grid brainstorm-grid 1280,760
harness bs NOTE="$REPO/sample-vault/Brainstorm.md" LEVEL=3 SORT=doc BG=bg-ocean \
	PLACEMENTS='[{"x":48,"y":48,"w":384,"h":264},{"x":456,"y":48,"w":264,"h":264},{"x":48,"y":336,"w":384,"h":312},{"x":456,"y":336,"w":264,"h":240},{"x":744,"y":48,"w":312,"h":216},{"x":744,"y":288,"w":312,"h":240},{"x":744,"y":552,"w":312,"h":216}]'
shoot bs custom brainstorm-custom 1440,800

echo "calendar ranges"
stage cal; cp "$REPO/tools/calendar-layout-note.md" "$WROOT/cal/Daily Notes 2026.md"
for r in month 2weeks week day; do
	harness cal NOTE="$WROOT/cal/Daily Notes 2026.md" CAL_RANGE=$r
	name=$([ "$r" = month ] && echo calendar || echo "calendar-$r"); shoot cal calendar "$name" 1280,760
done

echo "calendar feed"
stage feed; cp "$REPO/tools/calendar-feed-note.md" "$WROOT/feed/Daily Notes 2026.md"
harness feed NOTE="$WROOT/feed/Daily Notes 2026.md" CAL_RANGE=week; shoot feed calendar calendar-feed 1280,760

echo "calendar hero"
stage calhero; cp "$REPO/tools/calendar-hero-note.md" "$WROOT/calhero/Daily Notes 2026.md"
harness calhero NOTE="$WROOT/calhero/Daily Notes 2026.md"; shoot calhero calendar calendar-full 1280,760

echo "planner hero"
stage plan; cp "$REPO/tools/planner-hero-note.md" "$WROOT/plan/Daily Notes 2026.md"
harness plan NOTE="$WROOT/plan/Daily Notes 2026.md" LEVEL=3 TODAY=2026-08-06 ROLO_ACTIVE=2026-08-06; shoot plan planner planner-full 1280,760

echo "flash cards hero"
stage flash; cp "$REPO/tools/flashcards-hero-note.md" "$WROOT/flash/Study Deck.md"
harness flash NOTE="$WROOT/flash/Study Deck.md" SORT=doc FLIPPED="mitochondrion,Ohm,gato,Krebs"; shoot flash grid flashcards-full 1280,760

echo "sticky"
stage sticky; cp "$REPO/tools/sticky-note.md" "$WROOT/sticky/Daily Notes 2026.md"
harness sticky NOTE="$WROOT/sticky/Daily Notes 2026.md" LEVEL=3 TODAY=2026-08-06 ROLO_ACTIVE=2026-08-06 PAGE_W=520; shoot sticky sticky sticky 520,620

echo "mobile"
stage mob; harness mob MOBILE=1; shoot mob horizontal mobile-full 500,844 "--force-device-scale-factor=3"

echo "crops"
python3 "$REPO/tools/crop_screenshots.py" "$OUT"
# Everything but the uncropped captures replaces its screenshot, then the heroes follow.
for f in "$OUT"/*.png; do
	case "$(basename "$f")" in heatmap-full.png|context-menu-full.png|mobile-full.png) continue ;; esac
	cp "$f" "$REPO/screenshots/"
done
echo "heroes"
python3 "$REPO/tools/make_heroes.py" >/dev/null
rm -rf "$WROOT"
echo "done: $(ls "$REPO/screenshots" | wc -l) screenshots"
