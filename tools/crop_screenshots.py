"""Crop the README screenshots that are close-ups of a larger capture (rebuild-screenshots.sh):
the Heatmap graph (found by matching the committed crop inside the new capture, so the box
never drifts), the context menu (from the menu's own position in the page), the Day
Planner's top 600px, and the phone screen from its 3× capture.
  python3 tools/crop_screenshots.py <dir-of-captures>
"""
import re, sys
from PIL import Image, ImageChops, ImageStat
REPO = "/home/jlong/obsidian-plugins/single-file-section-cards"
OUT = sys.argv[1]

def locate(small, big, step=4):
    s = small.convert("L"); b = big.convert("L")
    ss = s.resize((s.width // step, s.height // step)); bs = b.resize((b.width // step, b.height // step))
    best = None
    for y in range(bs.height - ss.height + 1):
        for x in range(bs.width - ss.width + 1):
            d = ImageStat.Stat(ImageChops.difference(bs.crop((x, y, x + ss.width, y + ss.height)), ss)).sum[0]
            if best is None or d < best[0]: best = (d, x, y)
    _, cx, cy = best; best = None
    for y in range(max(0, cy * step - step), min(b.height - s.height, cy * step + step) + 1):
        for x in range(max(0, cx * step - step), min(b.width - s.width, cx * step + step) + 1):
            d = ImageStat.Stat(ImageChops.difference(b.crop((x, y, x + s.width, y + s.height)), s)).sum[0]
            if best is None or d < best[0]: best = (d, x, y)
    return best[1], best[2], best[0] / (s.width * s.height)

old = Image.open(f"{REPO}/screenshots/heatmap.png"); full = Image.open(f"{OUT}/heatmap-full.png")
x, y, err = locate(old, full)
full.crop((x, y, x + old.width, y + old.height)).save(f"{OUT}/heatmap.png"); print(f"heatmap at ({x},{y}) diff {err:.1f}")
dom = open(f"{OUT}/context-menu.dom.html", encoding="utf-8", errors="ignore").read()
m = re.search(r'class="menu[^"]*"[^>]*style="[^"]*left:\s*([\d.]+)px;[^"]*top:\s*([\d.]+)px', dom) or re.search(r'style="[^"]*left:\s*([\d.]+)px;[^"]*top:\s*([\d.]+)px[^"]*"[^>]*class="menu', dom)
bx, by = int(float(m.group(1)) - 163), int(float(m.group(2)) - 98)
Image.open(f"{OUT}/context-menu-full.png").crop((bx, by, bx + 650, by + 432)).save(f"{OUT}/context-menu.png"); print(f"context menu crop ({bx},{by})")
Image.open(f"{OUT}/planner-full.png").crop((0, 0, 1280, 600)).save(f"{OUT}/planner.png")
mob = Image.open(f"{OUT}/mobile-full.png"); w = 390 * 3; x0 = (mob.width - w) // 2
mob.crop((x0, 0, x0 + w, 844 * 3)).save(f"{OUT}/mobile-horizontal.png"); print("mobile", mob.size)
