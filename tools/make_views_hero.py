"""Compose the README's top hero: a headline over a thumbnail of every layout.

    python3 tools/make_views_hero.py      → screenshots/hero-views.webp

Thumbnails come from the layout screenshots in screenshots/ (rebuild those first:
tools/rebuild-screenshots.sh for the harness pages, tools/live-screenshots.mjs for
the Table, Tree and Binder). Same panel, fonts and colors as make_heroes.py.
"""

from PIL import Image, ImageDraw, ImageFont

FONTS = "/mnt/c/Windows/Fonts"
BOLD = f"{FONTS}/segoeuib.ttf"
REG = f"{FONTS}/segoeui.ttf"
SHOTS = "/home/jlong/obsidian-plugins/single-file-section-cards/screenshots"

# The layouts, in the picker's (alphabetical) order, each with its screenshot.
VIEWS = [
    ("Binder", "binder.png"),
    ("Calendar", "calendar.png"),
    ("Custom Grid", "custom.png"),
    ("Day Planner", "planner.png"),
    ("Grid", "grid.png"),
    ("Grid Aligned", "aligned.png"),
    ("Heatmap", "heatmap.png"),
    ("Horizontal", "horizontal.png"),
    ("Images", "images.png"),
    ("Links", "links.png"),
    ("Rolodex", "rolodex.png"),
    ("Table", "table.png"),
    ("Tasks Only", "tasks.png"),
    ("Tight", "tight.png"),
    ("Tree", "tree.png"),
    ("Vertical", "vertical.png"),
]

W = 2000
COLS = 4
PAD = 56
GAP = 28
THUMB_W = (W - 2 * PAD - (COLS - 1) * GAP) // COLS
THUMB_H = round(THUMB_W * 760 / 1280)
LABEL_H = 44
HEAD_H = 210

PANEL_BG = (14, 14, 17, 255)
WHITE = (245, 245, 247, 255)
GRAY = (146, 152, 160, 255)
FRAME = (52, 54, 60, 255)

HEAD = ImageFont.truetype(BOLD, 78)
SUB = ImageFont.truetype(REG, 36)
LABEL = ImageFont.truetype(REG, 26)


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def cover(img, w, h):
    """Scale to fill w×h and crop the overflow from the bottom/right (the shots share a
    top-left toolbar, so that corner is the one to keep)."""
    scale = max(w / img.width, h / img.height)
    scaled = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    return scaled.crop((0, 0, w, h))


rows = (len(VIEWS) + COLS - 1) // COLS
H = HEAD_H + rows * (THUMB_H + LABEL_H) + (rows - 1) * GAP + PAD
panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
draw = ImageDraw.Draw(panel)
draw.rounded_rectangle([0, 0, W - 1, H - 1], 36, fill=PANEL_BG)

draw.text((PAD, 54), "View notes however you want!", font=HEAD, fill=WHITE)
draw.text((PAD + 4, 150), f"{len(VIEWS)} layouts for one note — pick the one that fits the job, and switch any time.", font=SUB, fill=GRAY)

for i, (label, shot) in enumerate(VIEWS):
    col, row = i % COLS, i // COLS
    x = PAD + col * (THUMB_W + GAP)
    y = HEAD_H + row * (THUMB_H + LABEL_H + GAP)
    img = Image.open(f"{SHOTS}/{shot}").convert("RGBA")
    thumb = rounded(cover(img, THUMB_W, THUMB_H), 14)
    draw.rounded_rectangle([x - 1, y - 1, x + THUMB_W, y + THUMB_H], 15, outline=FRAME, width=2)
    panel.alpha_composite(thumb, (x, y))
    draw.text((x + 4, y + THUMB_H + 8), label, font=LABEL, fill=WHITE)

# WebP keeps the full colour of sixteen gradient backgrounds (a 256-colour PNG banded
# them) at a sixth of the PNG's size; GitHub renders it like any image.
panel.save(f"{SHOTS}/hero-views.webp", quality=90, method=6)
print("wrote screenshots/hero-views.webp", panel.size)
