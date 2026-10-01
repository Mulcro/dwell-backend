#!/usr/bin/env python3
"""
Draws a cover for a reading plan.

Every plan's artwork carries its own title, so a card is readable on its own and the
Plans screen does not depend on a label being drawn over the image. Run this for any new
plan rather than hand-making one, so they stay a set.

    ./scripts/make-plan-cover.py --title "When Life Gets Hard" --days 7 --out cover.png

The palette is chosen from the title when one is not given, so a plan keeps the same
colours every time this is run.
"""
import argparse
import hashlib
import pathlib
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 900
MARGIN = 86

SERIF = "/System/Library/Fonts/Supplemental/Baskerville.ttc"
SANS = "/System/Library/Fonts/Avenir Next.ttc"

# top, bottom, light. Deep and low-contrast: a title sits on these, and the card is small.
PALETTES = {
    "dawn": ((28, 32, 62), (9, 11, 22), (150, 96, 40)),
    "water": ((30, 66, 86), (10, 18, 30), (70, 122, 126)),
    "moss": ((30, 58, 48), (10, 20, 18), (88, 128, 82)),
    "dusk": ((52, 34, 64), (14, 10, 22), (132, 80, 118)),
    "ember": ((62, 34, 34), (18, 10, 12), (150, 76, 52)),
}


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def background(top, bottom, glow, seed):
    """Gradient, a soft light, a scatter of grain, and a scrim for the text."""
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        d.line([(0, y), (W, y)], fill=lerp(top, bottom, (y / H) ** 1.2))

    # Screen, not blend: blending warm light into dark navy averages out to brown.
    light = Image.new("RGB", (W, H), (0, 0, 0))
    gx, gy = int(W * 0.72), int(H * 0.26)
    ImageDraw.Draw(light).ellipse(
        [gx - W * 0.30, gy - W * 0.30, gx + W * 0.30, gy + W * 0.30], fill=glow
    )
    img = ImageChops.screen(img, light.filter(ImageFilter.GaussianBlur(radius=170)))

    # Flair: a faint scatter of light, denser near the glow. Seeded off the title so a
    # plan's stars land in the same place every time.
    rng = random.Random(seed)
    stars = Image.new("RGB", (W, H), (0, 0, 0))
    sd = ImageDraw.Draw(stars)
    for _ in range(90):
        x, y = rng.randrange(W), rng.randrange(int(H * 0.62))
        r = rng.choice([1, 1, 1, 2])
        v = rng.randint(40, 150)
        sd.ellipse([x - r, y - r, x + r, y + r], fill=(v, v, v))
    img = ImageChops.screen(img, stars.filter(ImageFilter.GaussianBlur(radius=0.6)))

    # Scrim: the lower half darkens so the title stays legible whatever is behind it.
    scrim = Image.new("L", (W, H), 0)
    sdraw = ImageDraw.Draw(scrim)
    for y in range(H):
        t = max(0.0, (y - H * 0.34) / (H * 0.66))
        sdraw.line([(0, y), (W, y)], fill=int(165 * (t**1.4)))
    return Image.composite(Image.new("RGB", (W, H), (6, 7, 12)), img, scrim)


def tracked(draw, xy, text, font, fill, tracking):
    """PIL has no letter-spacing, and small caps need it to read as a label."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x


def wrap(draw, text, font, width):
    lines, line = [], ""
    for word in text.split():
        trial = f"{line} {word}".strip()
        if draw.textlength(trial, font=font) <= width and len(lines) < 4:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def render(title, days, palette, out):
    seed = int(hashlib.sha256(title.encode()).hexdigest()[:8], 16)
    name = palette or list(PALETTES)[seed % len(PALETTES)]
    top, bottom, glow = PALETTES[name]

    img = background(top, bottom, glow, seed)
    d = ImageDraw.Draw(img)

    label = ImageFont.truetype(SANS, 25, index=2)  # Demi Bold
    serif = ImageFont.truetype(SERIF, 92, index=4)  # SemiBold

    # Title first: it decides how much room everything above it gets.
    lines = wrap(d, title, serif, W - MARGIN * 2)
    while len(lines) > 3 and serif.size > 58:
        serif = ImageFont.truetype(SERIF, serif.size - 8, index=4)
        lines = wrap(d, title, serif, W - MARGIN * 2)

    line_h = int(serif.size * 1.16)
    block_h = line_h * len(lines)
    baseline = H - MARGIN - block_h

    # Flair: a hairline rule, then the day count in tracked small caps above the title.
    rule_y = baseline - 64
    d.line([(MARGIN, rule_y), (MARGIN + 92, rule_y)], fill=(236, 226, 206), width=2)
    tracked(d, (MARGIN + 116, rule_y - 14), f"{days} DAYS", label, (226, 214, 192), 4.5)

    for i, line in enumerate(lines):
        y = baseline + i * line_h
        # A soft drop shadow, so the serif holds up over the lighter part of the glow.
        d.text((MARGIN + 2, y + 3), line, font=serif, fill=(0, 0, 0))
        d.text((MARGIN, y), line, font=serif, fill=(252, 250, 246))

    # Flair: three small marks closing the block, like a printer's device.
    y = H - MARGIN + 16
    for i in range(3):
        cx = MARGIN + 7 + i * 22
        d.ellipse([cx - 3, y - 3, cx + 3, y + 3], fill=(206, 190, 160))

    pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    return name


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--title", required=True)
    p.add_argument("--days", type=int, required=True)
    p.add_argument("--palette", choices=sorted(PALETTES))
    p.add_argument("--out", required=True)
    a = p.parse_args()
    print(f"{a.out}  palette={render(a.title, a.days, a.palette, a.out)}")
