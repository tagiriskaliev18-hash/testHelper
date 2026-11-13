#!/usr/bin/env python3
"""
Icon generator for 'Промбез & БИОТ РК — Помощник ИЦА' Chrome Extension.
Generates icons/icon-16.png, icons/icon-48.png, and icons/icon-128.png.

Supports Pillow if installed, and includes a 100% pure-Python fallback
(using zlib and struct from the standard library) with zero external dependencies.
"""

import math
import os
import struct
import sys
import zlib
from pathlib import Path


def create_png_rgba(width: int, height: int, rgba_bytes: bytes) -> bytes:
    """Encode raw RGBA byte buffer (width * height * 4) into a valid PNG byte string."""
    def chunk(chunk_type: bytes, data: bytes) -> bytes:
        length = len(data)
        crc = zlib.crc32(chunk_type + data) & 0xFFFFFFFF
        return struct.pack(">I", length) + chunk_type + data + struct.pack(">I", crc)

    # PNG Signature
    png_header = b"\x89PNG\r\n\x1a\n"

    # IHDR Chunk: width(4), height(4), bit_depth(1=8), color_type(1=6:RGBA), comp(1), filter(1), interlace(1)
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    ihdr = chunk(b"IHDR", ihdr_data)

    # Scanlines with filter byte 0 (None) at the start of each line
    scanlines = bytearray()
    row_bytes = width * 4
    for y in range(height):
        scanlines.append(0)  # filter type 0
        start = y * row_bytes
        scanlines.extend(rgba_bytes[start : start + row_bytes])

    compressed = zlib.compress(bytes(scanlines), level=9)
    idat = chunk(b"IDAT", compressed)
    iend = chunk(b"IEND", b"")

    return png_header + ihdr + idat + iend


def render_icon_raw(size: int) -> bytes:
    """Pure-Python rasterizer for dark slate badge with electric-blue shield & checkmark."""
    buffer = bytearray(size * size * 4)

    # Colors
    bg_dark = (15, 23, 42)       # Slate 900 #0f172a
    bg_light = (30, 41, 59)      # Slate 800 #1e293b
    border_col = (56, 189, 248)  # Electric blue accent
    shield_fill = (14, 116, 144) # Cyan 700
    shield_edge = (56, 189, 248) # Cyan 400
    check_col = (52, 211, 153)   # Emerald 400
    glow_col = (14, 165, 233)    # Blue 500

    center_x = size / 2.0
    center_y = size / 2.0
    radius = size * 0.42
    corner_r = size * 0.22

    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            # Normalized coordinates [-1, 1]
            nx = (x + 0.5 - center_x) / (size / 2.0)
            ny = (y + 0.5 - center_y) / (size / 2.0)

            # Rounded square SDF
            # Box half-dimensions: 0.82 x 0.82, radius: 0.22
            bx, by = 0.82, 0.82
            dx = max(abs(nx) - (bx - corner_r / (size / 2.0)), 0.0)
            dy = max(abs(ny) - (by - corner_r / (size / 2.0)), 0.0)
            dist_box = math.sqrt(dx * dx + dy * dy) - (corner_r / (size / 2.0))

            if dist_box > 0.08:
                # Outside
                buffer[idx : idx + 4] = b"\x00\x00\x00\x00"
                continue

            # Anti-aliasing alpha for outer edge
            if dist_box > 0:
                box_alpha = max(0.0, min(1.0, 1.0 - dist_box / 0.08))
            else:
                box_alpha = 1.0

            # Vertical gradient for background
            grad = (ny + 1.0) / 2.0
            r = int(bg_light[0] * (1.0 - grad) + bg_dark[0] * grad)
            g = int(bg_light[1] * (1.0 - grad) + bg_dark[1] * grad)
            b = int(bg_light[2] * (1.0 - grad) + bg_dark[2] * grad)
            a = int(255 * box_alpha)

            # Subtle outer border ring
            if -0.06 < dist_box <= 0.0:
                border_blend = (-dist_box) / 0.06
                r = int(r * border_blend + border_col[0] * (1.0 - border_blend) * 0.4)
                g = int(g * border_blend + border_col[1] * (1.0 - border_blend) * 0.4)
                b = int(b * border_blend + border_col[2] * (1.0 - border_blend) * 0.4)

            # Shield geometry inside (normalized coords)
            # Top at ny = -0.45, bottom at ny = 0.50, half-width 0.45
            sx = abs(nx)
            sy = ny
            in_shield = False
            shield_dist = 1.0

            if -0.45 <= sy <= 0.55:
                if sy <= -0.1:
                    max_w = 0.46
                else:
                    # Taper to point at bottom
                    t = (sy - (-0.1)) / 0.65
                    max_w = 0.46 * (1.0 - (t * 0.95))
                if sx <= max_w:
                    in_shield = True
                    shield_dist = max_w - sx

            if in_shield:
                # Shield background
                sr, sg, sb = shield_fill
                if shield_dist < 0.08:
                    # Shield edge
                    sr, sg, sb = shield_edge
                r = int(r * 0.2 + sr * 0.8)
                g = int(g * 0.2 + sg * 0.8)
                b = int(b * 0.2 + sb * 0.8)

            # Checkmark inside shield: points (-0.22, 0.05) -> (-0.05, 0.25) -> (0.24, -0.18)
            # Distance to checkmark polyline segments
            def dist_segment(px, py, x1, y1, x2, y2):
                vx = x2 - x1
                vy = y2 - y1
                wx = px - x1
                wy = py - y1
                c1 = vx * wx + vy * wy
                if c1 <= 0:
                    return math.hypot(px - x1, py - y1)
                c2 = vx * vx + vy * vy
                if c2 <= c1:
                    return math.hypot(px - x2, py - y2)
                b = c1 / c2
                proj_x = x1 + b * vx
                proj_y = y1 + b * vy
                return math.hypot(px - proj_x, py - proj_y)

            d1 = dist_segment(nx, ny, -0.22, 0.04, -0.05, 0.24)
            d2 = dist_segment(nx, ny, -0.05, 0.24, 0.24, -0.20)
            check_d = min(d1, d2)
            check_thick = 0.095 if size > 32 else 0.14

            if check_d < check_thick:
                calpha = min(1.0, (check_thick - check_d) / 0.03) if size > 32 else 1.0
                r = int(r * (1.0 - calpha) + check_col[0] * calpha)
                g = int(g * (1.0 - calpha) + check_col[1] * calpha)
                b = int(b * (1.0 - calpha) + check_col[2] * calpha)

            buffer[idx : idx + 4] = bytes([r, g, b, a])

    return bytes(buffer)


def render_with_pillow(size: int, output_path: Path):
    """Render high quality icon using Pillow."""
    from PIL import Image, ImageDraw, ImageFilter

    scale = 4  # 4x supersampling for ultra crisp edges
    w = size * scale
    h = size * scale

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = int(w * 0.06)
    radius = int(w * 0.22)

    # Base rounded slate badge
    rect = [margin, margin, w - margin, h - margin]
    draw.rounded_rectangle(rect, radius=radius, fill=(15, 23, 42, 255), outline=(56, 189, 248, 180), width=max(2, int(scale * 1.5)))

    # Inner subtle glow rectangle
    inner_m = margin + int(scale * 2)
    inner_rect = [inner_m, inner_m, w - inner_m, h - inner_m]
    draw.rounded_rectangle(inner_rect, radius=max(2, radius - int(scale * 2)), fill=(30, 41, 59, 240))

    # Shield polygon
    cx, cy = w / 2, h / 2
    sw = w * 0.28
    st = h * 0.24
    sb = h * 0.78
    smid = h * 0.44

    shield_pts = [
        (cx - sw, st),
        (cx + sw, st),
        (cx + sw, smid),
        (cx, sb),
        (cx - sw, smid),
    ]
    draw.polygon(shield_pts, fill=(14, 116, 144, 255), outline=(56, 189, 248, 255))

    # Checkmark inside shield
    ck_w = max(int(scale * 3.5), int(w * 0.075))
    p1 = (int(cx - sw * 0.52), int(cy + h * 0.02))
    p2 = (int(cx - sw * 0.12), int(cy + h * 0.18))
    p3 = (int(cx + sw * 0.58), int(cy - h * 0.16))

    draw.line([p1, p2, p3], fill=(52, 211, 153, 255), width=ck_w, joint="curve")

    # Downsample with Lanczos for perfect anti-aliasing
    final_img = img.resize((size, size), Image.Resampling.LANCZOS)
    final_img.save(output_path, format="PNG", optimize=True)


def generate_all_icons(target_dir: Path):
    target_dir.mkdir(parents=True, exist_ok=True)
    sizes = [16, 48, 128]

    has_pillow = False
    try:
        import PIL
        has_pillow = True
    except ImportError:
        pass

    for size in sizes:
        dest = target_dir / f"icon-{size}.png"
        if has_pillow:
            try:
                render_with_pillow(size, dest)
                print(f"[Pillow] Generated {dest.relative_to(target_dir.parent)} ({size}x{size})")
                continue
            except Exception as e:
                print(f"Pillow render failed ({e}), falling back to pure Python...")

        # Pure Python fallback
        raw_rgba = render_icon_raw(size)
        png_data = create_png_rgba(size, size, raw_rgba)
        dest.write_bytes(png_data)
        print(f"[Pure-Python] Generated {dest.relative_to(target_dir.parent)} ({size}x{size})")


if __name__ == "__main__":
    project_root = Path(__file__).resolve().parent.parent
    icons_dir = project_root / "icons"
    print(f"Generating extension icons in {icons_dir}...")
    generate_all_icons(icons_dir)
    print("Done generating all icons.")
