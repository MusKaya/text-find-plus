#!/usr/bin/env python3
# Copyright (C) 2026 The Text Find+ contributors
# SPDX-License-Identifier: GPL-3.0-or-later
"""Draw the Text Find+ toolbar icons (16, 48, 128 px) as PNG files.

Standard library only. Shapes are described in coordinates from 0 to 1 and
rendered with 4x4 supersampling for smooth edges:
a blue rounded square, a white magnifying glass and a white "+" at the top right (bolder at 16 px).

Usage: python3 tools/make-icons.py [out_dir]
"""
import math
import os
import struct
import sys
import zlib

BLUE = (0x25, 0x63, 0xEB)
WHITE = (0xFF, 0xFF, 0xFF)
SIZES = (16, 48, 128)
SAMPLES = 4

RING_CENTRE = (0.42, 0.44)
RING_RADIUS = 0.22
RING_STROKE = 0.075
HANDLE_END = (0.80, 0.82)
HANDLE_STROKE = 0.10
CORNER_RADIUS = 0.22


def in_rounded_square(x, y):
    # Signed distance to a square of half-size 0.5 centred at (0.5, 0.5) with rounded corners.
    qx = abs(x - 0.5) - (0.5 - CORNER_RADIUS)
    qy = abs(y - 0.5) - (0.5 - CORNER_RADIUS)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - CORNER_RADIUS <= 0


def near_segment(x, y, ax, ay, bx, by, half_width):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= half_width


def in_plus(x, y, cx, cy, arm, stroke):
    h = stroke / 2
    return (abs(x - cx) <= arm and abs(y - cy) <= h) or (abs(y - cy) <= arm and abs(x - cx) <= h)


def in_glyph(x, y, size):
    cx, cy = RING_CENTRE
    if abs(math.hypot(x - cx, y - cy) - RING_RADIUS) <= RING_STROKE / 2:
        return True
    start = (cx + RING_RADIUS * math.cos(math.pi / 4), cy + RING_RADIUS * math.sin(math.pi / 4))
    if near_segment(x, y, start[0], start[1], HANDLE_END[0], HANDLE_END[1], HANDLE_STROKE / 2):
        return True
    if size <= 16:
        return in_plus(x, y, 0.80, 0.20, 0.12, 0.07)
    return in_plus(x, y, 0.80, 0.20, 0.10, 0.06)


def render(size):
    """Return RGBA rows (bytes) for one icon size."""
    rows = []
    n = SAMPLES * SAMPLES
    for py in range(size):
        row = bytearray()
        for px in range(size):
            bg = fg = 0
            for sy in range(SAMPLES):
                for sx in range(SAMPLES):
                    x = (px + (sx + 0.5) / SAMPLES) / size
                    y = (py + (sy + 0.5) / SAMPLES) / size
                    if in_rounded_square(x, y):
                        if in_glyph(x, y, size):
                            fg += 1
                        else:
                            bg += 1
            covered = bg + fg
            if covered == 0:
                row += bytes((0, 0, 0, 0))
                continue
            colour = [round((BLUE[i] * bg + WHITE[i] * fg) / covered) for i in range(3)]
            row += bytes(colour + [round(255 * covered / n)])
        rows.append(bytes(row))
    return rows


def png_bytes(size, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA, no interlace
    raw = b''.join(b'\x00' + r for r in rows)  # filter type 0 on every row
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', header) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')


def main(out_dir='src/icons'):
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(out_dir, 'icon%d.png' % size)
        with open(path, 'wb') as f:
            f.write(png_bytes(size, render(size)))
        print('wrote', path)


if __name__ == '__main__':
    main(*sys.argv[1:2])
