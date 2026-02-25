#!/usr/bin/env python3
"""
Generate PNG icons for the KithKit Chrome Connect extension.

Uses only Python stdlib (struct, zlib) — no Pillow or external deps needed.
Produces solid-color rounded-square icons with the letter "K" rendered via
a simple pixel font baked into this script.

Usage:
    python3 scripts/generate-icons.py

Output: icons/icon-16.png, icons/icon-48.png, icons/icon-128.png
"""

import os
import struct
import zlib

# ---------------------------------------------------------------------------
# Colors (RGBA)
# ---------------------------------------------------------------------------
BG_COLOR  = (0x00, 0xd4, 0xaa, 0xff)   # KithKit teal
FG_COLOR  = (0x1a, 0x1a, 0x2e, 0xff)   # dark navy — "K" letter
TRANS     = (0x00, 0x00, 0x00, 0x00)   # transparent

# ---------------------------------------------------------------------------
# Minimal PNG encoder (pure stdlib)
# ---------------------------------------------------------------------------

def _chunk(chunk_type: bytes, data: bytes) -> bytes:
    """Pack a PNG chunk: length + type + data + CRC."""
    c = chunk_type + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xFFFFFFFF)


def write_png(path: str, pixels: list[list[tuple]], width: int, height: int) -> None:
    """
    Write an RGBA PNG file.
    pixels[y][x] = (R, G, B, A) tuple, each 0-255.
    """
    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    # color type 2 = RGB; we'll use color type 6 = RGBA
    ihdr_data = struct.pack('>II', width, height) + bytes([8, 6, 0, 0, 0])
    ihdr = _chunk(b'IHDR', ihdr_data)

    # IDAT — raw image data with filter byte per row
    raw_rows = []
    for row in pixels:
        row_bytes = b'\x00'  # filter type 0 = None
        for (r, g, b, a) in row:
            row_bytes += bytes([r, g, b, a])
        raw_rows.append(row_bytes)

    raw_data = b''.join(raw_rows)
    compressed = zlib.compress(raw_data, 9)
    idat = _chunk(b'IDAT', compressed)

    # IEND
    iend = _chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(sig + ihdr + idat + iend)


# ---------------------------------------------------------------------------
# Shape helpers
# ---------------------------------------------------------------------------

def rounded_square(size: int, radius_frac: float = 0.18) -> list[list[bool]]:
    """
    Return a 2D boolean mask: True if pixel is inside a rounded square.
    radius_frac is the corner radius as a fraction of size.
    """
    r = radius_frac * size
    mask = []
    for y in range(size):
        row = []
        for x in range(size):
            # Distance to nearest corner center
            cx = max(r, min(size - r - 1, x))
            cy = max(r, min(size - r - 1, y))
            dx = x - cx
            dy = y - cy
            inside = (dx * dx + dy * dy) <= r * r
            # Also inside if in the "body" rectangle (not in a corner zone)
            in_body = (r <= x <= size - r - 1) or (r <= y <= size - r - 1)
            row.append(inside or in_body)
        mask.append(row)
    return mask


# ---------------------------------------------------------------------------
# Minimal "K" glyph (pixel font, 5×7 grid, scaled to fit)
# ---------------------------------------------------------------------------
# Each row: 5 bits, MSB first. 1 = foreground.
K_GLYPH_5x7 = [
    0b10001,
    0b10010,
    0b10100,
    0b11000,
    0b10100,
    0b10010,
    0b10001,
]

def draw_K(pixels: list[list[tuple]], size: int, fg: tuple, bg: tuple) -> None:
    """
    Draw a pixel-art "K" centered in the icon grid.
    Scales the 5×7 glyph proportionally to ~50% of icon height.
    """
    glyph_h = 7
    glyph_w = 5

    # Target rendered size
    cell_h = max(1, int(size * 0.50 / glyph_h))
    cell_w = max(1, int(size * 0.50 / glyph_w))

    rendered_h = cell_h * glyph_h
    rendered_w = cell_w * glyph_w

    # Center offset
    off_y = (size - rendered_h) // 2
    off_x = (size - rendered_w) // 2

    for gy, row_bits in enumerate(K_GLYPH_5x7):
        for gx in range(glyph_w):
            bit = (row_bits >> (glyph_w - 1 - gx)) & 1
            color = fg if bit else bg
            for dy in range(cell_h):
                for dx in range(cell_w):
                    py = off_y + gy * cell_h + dy
                    px = off_x + gx * cell_w + dx
                    if 0 <= py < size and 0 <= px < size:
                        pixels[py][px] = color


# ---------------------------------------------------------------------------
# Build pixel grid for a given size
# ---------------------------------------------------------------------------

def make_icon(size: int) -> list[list[tuple]]:
    mask = rounded_square(size)

    # Start fully transparent
    pixels = [[TRANS] * size for _ in range(size)]

    # Fill background inside the rounded square
    for y in range(size):
        for x in range(size):
            if mask[y][x]:
                pixels[y][x] = BG_COLOR

    # Draw "K"
    draw_K(pixels, size, FG_COLOR, BG_COLOR)

    # Anti-alias the rounded corners slightly (blend edge pixels with transparent)
    # For small icons keep it simple — just soften the outermost edge
    if size >= 48:
        for y in range(size):
            for x in range(size):
                if not mask[y][x]:
                    # Check if any neighbour is inside
                    nbrs = []
                    for ny, nx in [(y-1,x),(y+1,x),(y,x-1),(y,x+1)]:
                        if 0 <= ny < size and 0 <= nx < size:
                            nbrs.append(mask[ny][nx])
                    if any(nbrs):
                        # 50% alpha edge pixel
                        r, g, b, _ = BG_COLOR
                        pixels[y][x] = (r, g, b, 128)

    return pixels


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    icons_dir  = os.path.join(script_dir, '..', 'icons')
    os.makedirs(icons_dir, exist_ok=True)

    for size in (16, 48, 128):
        path = os.path.join(icons_dir, f'icon-{size}.png')
        pixels = make_icon(size)
        write_png(path, pixels, size, size)
        print(f'  Generated {path}  ({size}×{size})')


if __name__ == '__main__':
    main()
