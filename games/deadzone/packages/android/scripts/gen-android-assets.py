#!/usr/bin/env python3
"""
Generates every Android bitmap resource OVERRUN needs from the artwork that
already ships with the PWA. Nothing new is drawn: the source is
packages/client/public/icons/icon-1024.png, and everything here is a
derivation of it.

  mipmap-*/ic_launcher.png             legacy square launcher icon
  mipmap-*/ic_launcher_round.png       legacy round launcher icon
  mipmap-*/ic_launcher_foreground.png  adaptive icon foreground layer
  drawable-*/splash_logo.png           splash / API 31 splash-screen icon

The adaptive foreground is the logo lifted off its dark plate: the plate is a
near-black navy gradient and the mark is amber and near-white, so a luminance
ramp separates them cleanly and keeps the antialiased edges soft.

Run:  python3 scripts/gen-android-assets.py
"""

import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
SRC = os.path.join(ROOT, "packages", "client", "public", "icons", "icon-1024.png")
RES = os.path.join(HERE, "..", "android", "app", "src", "main", "res")

# density buckets, as a multiplier of 1dp = 1px at mdpi
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}

# luminance ramp used to key the dark plate out of the artwork
LUM_LOW, LUM_HIGH = 0.15, 0.28


def out(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def keyed_logo(src):
    """The mark on transparency, cropped to its bounding box."""
    im = src.convert("RGB")
    w, h = im.size
    px = im.load()
    alpha = Image.new("L", (w, h))
    ap = alpha.load()
    span = LUM_HIGH - LUM_LOW
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
            t = (lum - LUM_LOW) / span
            ap[x, y] = 0 if t <= 0 else (255 if t >= 1 else int(t * 255))
    rgba = im.convert("RGBA")
    rgba.putalpha(alpha)
    # Bounding box from the confidently-opaque pixels only, so a stray pixel of
    # residual plate gradient cannot inflate the box and shrink the mark.
    box = alpha.point(lambda v: 255 if v > 48 else 0).getbbox()
    return rgba.crop(box) if box else rgba


def fit(img, canvas_px, content_px):
    """Centre img inside a transparent square canvas, longest side = content_px."""
    c = Image.new("RGBA", (canvas_px, canvas_px), (0, 0, 0, 0))
    w, h = img.size
    scale = content_px / float(max(w, h))
    r = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    c.paste(r, ((canvas_px - r.size[0]) // 2, (canvas_px - r.size[1]) // 2), r)
    return c


def circle_crop(img):
    size = img.size[0]
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS).filter(ImageFilter.SMOOTH)
    o = img.convert("RGBA")
    o.putalpha(mask)
    return o


def main():
    src = Image.open(SRC)
    logo = keyed_logo(src)
    print("source", src.size, "-> keyed mark", logo.size)

    written = 0
    for bucket, mult in DENSITIES.items():
        # --- legacy launcher icons: 48dp, straight from the plated artwork
        px = int(48 * mult)
        square = src.convert("RGBA").resize((px, px), Image.LANCZOS)
        square.save(out(os.path.join(RES, "mipmap-" + bucket, "ic_launcher.png")))
        circle_crop(square).save(out(os.path.join(RES, "mipmap-" + bucket, "ic_launcher_round.png")))

        # --- adaptive foreground: 108dp canvas, mark inside the 66dp safe zone
        fg = fit(logo, int(108 * mult), int(58 * mult))
        fg.save(out(os.path.join(RES, "mipmap-" + bucket, "ic_launcher_foreground.png")))

        # --- splash icon: 288dp canvas, mark inside the 160dp visible circle
        sp = fit(logo, int(288 * mult), int(150 * mult))
        sp.save(out(os.path.join(RES, "drawable-" + bucket, "splash_logo.png")))
        written += 4

    print("wrote", written, "files under", os.path.normpath(RES))


if __name__ == "__main__":
    main()
