#!/usr/bin/env python3
"""Render the extension icon as 16/32/48/128 PNGs.

Each size is drawn at its native resolution so small sizes are crisp instead
of being downscaled from 128. Run from this directory:

    python3 icons/_render.py

The script writes icon{16,32,48,128}.png and icon_source.svg next to itself,
then deletes itself (Chrome refuses to load extensions with '_'-prefixed
files). Re-run by re-creating this file.
"""
from __future__ import annotations
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
BG = (29, 64, 62, 255)          # deep teal
FG = (244, 237, 224, 255)       # warm off-white
DOT = (29, 64, 62, 255)         # bubble dots same as bg


def render(size: int, out: Path) -> None:
    s = size * 4  # supersample then downscale once at the end
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    radius = int(s * 0.22)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=radius, fill=BG)

    pad = int(s * 0.16)
    bw = s - 2 * pad
    bh = int(bw * 0.78)
    bx0, by0 = pad, pad + int(s * 0.04)
    bx1, by1 = bx0 + bw, by0 + bh
    bubble_radius = int(bh * 0.30)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=bubble_radius, fill=FG)

    tail_w = int(bw * 0.22)
    tail_h = int(bh * 0.30)
    tail_x = bx0 + int(bw * 0.18)
    tail_y = by1
    tail = [
        (tail_x, tail_y - 2),
        (tail_x + tail_w, tail_y - 2),
        (tail_x + int(tail_w * 0.15), tail_y + tail_h),
    ]
    d.polygon(tail, fill=FG)

    cy = by0 + bh // 2
    dot_radius = max(2, int(bh * 0.12))
    spacing = int(bw * 0.22)
    cx_center = bx0 + bw // 2
    for cx in (cx_center - spacing, cx_center, cx_center + spacing):
        d.ellipse(
            (cx - dot_radius, cy - dot_radius, cx + dot_radius, cy + dot_radius),
            fill=DOT,
        )

    final = img.resize((size, size), Image.LANCZOS)
    final.save(out, format="PNG", optimize=True)


def write_source_svg(out: Path) -> None:
    out.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" '
        'aria-label="Chatbot Archiver icon">\n'
        '  <rect width="128" height="128" rx="28" fill="#1d403e"/>\n'
        '  <rect x="20" y="25" width="88" height="62" rx="14" fill="#f4ede0"/>\n'
        '  <polygon points="36,87 56,87 41,103" fill="#f4ede0"/>\n'
        '  <circle cx="44" cy="56" r="6.5" fill="#1d403e"/>\n'
        '  <circle cx="64" cy="56" r="6.5" fill="#1d403e"/>\n'
        '  <circle cx="84" cy="56" r="6.5" fill="#1d403e"/>\n'
        '</svg>\n',
        encoding="utf-8",
    )


def main() -> int:
    for size in (16, 32, 48, 128):
        render(size, HERE / f"icon{size}.png")
    write_source_svg(HERE / "icon_source.svg")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
