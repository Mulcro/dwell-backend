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

# The card crops this to fill, and the aspect it crops to is the client's business, not
# ours. So everything that must be readable lives inside a box that survives the whole
# plausible range -- 16:9 (slices top and bottom) through 3:4 portrait (slices the
# sides). Centred, because a crop eats the edges evenly.
#   16:9  keeps y 112..788      3:4 portrait keeps x 262..937
SAFE_W, SAFE_H = 640, 660

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
    gx, gy = int(W * 0.70), int(H * 0.22)
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
        # Darkest through the middle band, where the title sits, and eased at both ends
        # so no crop reveals a hard edge.
        t = 1.0 - min(1.0, abs(y - H * 0.5) / (H * 0.46))
        sdraw.line([(0, y), (W, y)], fill=int(120 * (t**1.5)))
    return Image.composite(Image.new("RGB", (W, H), (6, 7, 12)), img, scrim)


def tracked(draw, xy, text, font, fill, tracking):
    """PIL has no letter-spacing, and small caps need it to read as a label."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x


def _greedy(draw, words, font, width):
    lines, line = [], ""
    for word in words:
        trial = f"{line} {word}".strip()
        if not line or draw.textlength(trial, font=font) <= width:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def wrap(draw, text, font, width):
    """
    Wraps to balanced lines rather than greedy ones.

    Greedy packing gives "When Life Gets / Hard", which looks like a mistake on a cover.
    Narrowing the measure until the line COUNT would change finds the tightest width that
    still fits, which evens the lines out.
    """
    words = text.split()
    lines = _greedy(draw, words, font, width)
    target = len(lines)
    if target < 2:
        return lines

    lo, hi, best = 1, int(width), lines
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = _greedy(draw, words, font, mid)
        if len(candidate) <= target:
            best, hi = candidate, mid - 1
        else:
            lo = mid + 1
    return best


def render(title, days, palette, out):
    seed = int(hashlib.sha256(title.encode()).hexdigest()[:8], 16)
    name = palette or list(PALETTES)[seed % len(PALETTES)]
    top, bottom, glow = PALETTES[name]

    img = background(top, bottom, glow, seed)
    d = ImageDraw.Draw(img)

    label = ImageFont.truetype(SANS, 23, index=2)  # Demi Bold
    serif = ImageFont.truetype(SERIF, 76, index=4)  # SemiBold

    # Shrink until the title fits the safe box in at most three lines. A cover that
    # overflows is worse than one set a size smaller.
    lines = wrap(d, title, serif, SAFE_W)
    while (len(lines) > 3 or max(d.textlength(l, font=serif) for l in lines) > SAFE_W) \
            and serif.size > 40:
        serif = ImageFont.truetype(SERIF, serif.size - 4, index=4)
        lines = wrap(d, title, serif, SAFE_W)

    line_h = int(serif.size * 1.18)
    rule_gap, dot_gap = 58, 54
    block_h = rule_gap + line_h * len(lines) + dot_gap
    y = (H - block_h) // 2
    cx = W // 2

    # Flair: hairline rule, then the day count in tracked small caps, both centred.
    caps = f"{days} DAYS"
    caps_w = sum(d.textlength(c, font=label) + 4.5 for c in caps) - 4.5
    rule = 58
    d.line([(cx - caps_w / 2 - rule - 20, y), (cx - caps_w / 2 - 20, y)],
           fill=(236, 226, 206), width=2)
    d.line([(cx + caps_w / 2 + 20, y), (cx + caps_w / 2 + rule + 20, y)],
           fill=(236, 226, 206), width=2)
    tracked(d, (cx - caps_w / 2, y - 13), caps, label, (226, 214, 192), 4.5)

    y += rule_gap
    for line in lines:
        w = d.textlength(line, font=serif)
        d.text((cx - w / 2 + 2, y + 3), line, font=serif, fill=(0, 0, 0))
        d.text((cx - w / 2, y), line, font=serif, fill=(252, 250, 246))
        y += line_h

    # Flair: three small marks closing the block, like a printer's device.
    y += 18
    for i in range(3):
        px = cx - 22 + i * 22
        d.ellipse([px - 3, y - 3, px + 3, y + 3], fill=(206, 190, 160))

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
