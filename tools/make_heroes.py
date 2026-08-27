"""Compose README hero banners: dark rounded panel, big headline left, screenshot right."""
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = "/mnt/c/Windows/Fonts"
BOLD = f"{FONTS}/segoeuib.ttf"
REG = f"{FONTS}/segoeui.ttf"
SHOTS = "/home/jlong/obsidian-plugins/single-file-section-cards/screenshots"

W, H = 2000, 640
PANEL_BG = (14, 14, 17, 255)
WHITE = (245, 245, 247, 255)
GRAY = (146, 152, 160, 255)

HEAD = ImageFont.truetype(BOLD, 84)
SUB = ImageFont.truetype(REG, 36)


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.size[0] - 1, img.size[1] - 1], radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def banner(shot_name, lines, subtitle, out_name):
    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(panel)
    draw.rounded_rectangle([0, 0, W - 1, H - 1], 40, fill=PANEL_BG)

    # Screenshot: fit right side, rounded, thin border, soft shadow.
    shot = Image.open(f"{SHOTS}/{shot_name}").convert("RGBA")
    sh = 540
    sw = round(shot.size[0] * sh / shot.size[1])
    shot = rounded(shot.resize((sw, sh), Image.LANCZOS), 18)
    sx, sy = W - sw - 52, (H - sh) // 2

    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([sx - 8, sy + 4, sx + sw + 8, sy + sh + 16], 24, fill=(0, 0, 0, 160))
    panel.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))
    panel.alpha_composite(shot, (sx, sy))
    ImageDraw.Draw(panel).rounded_rectangle([sx, sy, sx + sw - 1, sy + sh - 1], 18, outline=(58, 58, 64, 255), width=2)

    # Headline: list of lines, each a list of (text, color) segments.
    line_h = 102
    block_h = len(lines) * line_h + 28 + 48
    y = (H - block_h) // 2
    x0 = 96
    d = ImageDraw.Draw(panel)
    for segs in lines:
        x = x0
        for text, color in segs:
            d.text((x, y), text, font=HEAD, fill=color)
            x += d.textlength(text, font=HEAD)
        y += line_h
    y += 28
    d.text((x0, y), subtitle, font=SUB, fill=GRAY)

    panel.save(f"{SHOTS}/{out_name}")
    print(out_name, panel.size)


YELLOW = (247, 207, 107, 255)
PINK = (239, 127, 174, 255)
BLUE = (108, 184, 255, 255)
PURPLE = (177, 140, 255, 255)
TEAL = (95, 212, 196, 255)
GREEN = (158, 219, 106, 255)
CORAL = (242, 131, 107, 255)

banner(
    "grid.png",
    [
        [("The best of", WHITE)],
        [("sticky notes", YELLOW)],
        [("and ", WHITE), ("daily notes", PINK), (".", WHITE)],
        [("Built for Obsidian.", WHITE)],
    ],
    "One card per heading — edit everything in place.",
    "hero-cards.png",
)

banner(
    "brainstorm-custom.png",
    [
        [("The best of", WHITE)],
        [("whiteboards", TEAL)],
        [("and ", WHITE), ("kanban", PURPLE), (".", WHITE)],
        [("Built for Obsidian.", WHITE)],
    ],
    "Drag, place, and resize sections on a canvas.",
    "hero-canvas.png",
)

banner(
    "calendar.png",
    [
        [("The best of", WHITE)],
        [("a journal", GREEN)],
        [("and ", WHITE), ("a calendar", CORAL), (".", WHITE)],
        [("Built for Obsidian.", WHITE)],
    ],
    "Your days on a monthly grid, today highlighted.",
    "hero-calendar.png",
)
