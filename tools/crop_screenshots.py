"""Crop the README screenshots that are close-ups of a larger capture (rebuild-screenshots.sh):
the context menu (from the menu's own position in the page), the Day
Planner's top 600px, and the phone screen from its 3× capture.
  python3 tools/crop_screenshots.py <dir-of-captures>
"""
import re, sys
from PIL import Image
REPO = "/home/jlong/obsidian-plugins/single-file-section-cards"
OUT = sys.argv[1]

dom = open(f"{OUT}/context-menu.dom.html", encoding="utf-8", errors="ignore").read()
m = re.search(r'class="menu[^"]*"[^>]*style="[^"]*left:\s*([\d.]+)px;[^"]*top:\s*([\d.]+)px', dom) or re.search(r'style="[^"]*left:\s*([\d.]+)px;[^"]*top:\s*([\d.]+)px[^"]*"[^>]*class="menu', dom)
bx, by = int(float(m.group(1)) - 163), int(float(m.group(2)) - 98)
Image.open(f"{OUT}/context-menu-full.png").crop((bx, by, bx + 650, by + 432)).save(f"{OUT}/context-menu.png"); print(f"context menu crop ({bx},{by})")
Image.open(f"{OUT}/planner-full.png").crop((0, 0, 1280, 600)).save(f"{OUT}/planner.png")
mob = Image.open(f"{OUT}/mobile-full.png"); w = 390 * 3; x0 = (mob.width - w) // 2
mob.crop((x0, 0, x0 + w, 844 * 3)).save(f"{OUT}/mobile-horizontal.png"); print("mobile", mob.size)
