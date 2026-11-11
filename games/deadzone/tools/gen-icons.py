"""Generate the OVERRUN icon set.

Run with: npm run assets

These are build artefacts, not source. Committing generated PNGs to git means
every tweak to the mark costs a binary diff nobody can review, and the repo
grows forever. The drawing below is the source of truth.

One drawing rendered at every size the platforms ask for. The maskable variant
keeps all its meaning inside the inner 80% safe zone, because Android will crop
a circle out of it and a logo that touches the edge loses its head.
"""
from PIL import Image, ImageDraw, ImageFont
import math, os

OUT = os.path.join(os.path.dirname(__file__), "..", "packages", "client", "public", "icons")
os.makedirs(OUT, exist_ok=True)

INK   = (14, 22, 32)
AMBER = (255, 181, 61)
ROSE  = (255, 45, 107)
BONE  = (238, 243, 246)
STEEL = (124, 147, 164)

def draw(size, maskable=False):
    S = size * 4  # supersample, then downscale — cheap antialiasing
    img = Image.new("RGB", (S, S), INK)
    d = ImageDraw.Draw(img, "RGBA")

    # Background: a warm-to-cold vertical wash so the icon has depth at 48px.
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=(
            int(14 + 12 * (1 - t)), int(22 + 16 * (1 - t)), int(32 + 20 * (1 - t))))

    pad = S * 0.20 if maskable else S * 0.10
    inner = S - pad * 2
    cx = cy = S / 2

    # Arena ring: the game is a circle you cannot leave.
    r = inner * 0.44
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=STEEL + (110,), width=int(S * 0.012))
    r2 = inner * 0.375
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], outline=AMBER + (200,), width=int(S * 0.020))

    # Four threat wedges closing in from the corners — "you are outnumbered".
    for i in range(4):
        a = math.radians(45 + i * 90)
        dist = inner * 0.395
        px, py = cx + math.cos(a) * dist, cy + math.sin(a) * dist
        L = inner * 0.075
        pts = [
            (px + math.cos(a + math.pi) * L, py + math.sin(a + math.pi) * L),
            (px + math.cos(a + 2.4) * L, py + math.sin(a + 2.4) * L),
            (px + math.cos(a - 2.4) * L, py + math.sin(a - 2.4) * L),
        ]
        d.polygon(pts, fill=ROSE + (235,))

    # The player: a single amber wedge at the centre, facing right.
    L = inner * 0.15
    d.polygon([
        (cx + L * 1.05, cy),
        (cx - L * 0.62, cy + L * 0.72),
        (cx - L * 0.28, cy),
        (cx - L * 0.62, cy - L * 0.72),
    ], fill=AMBER)

    # Muzzle flash, so the mark reads as a shooter rather than a compass.
    fl = inner * 0.055
    d.polygon([
        (cx + L * 1.15, cy),
        (cx + L * 1.15 + fl, cy - fl * 0.5),
        (cx + L * 1.15 + fl * 1.5, cy),
        (cx + L * 1.15 + fl, cy + fl * 0.5),
    ], fill=BONE + (240,))

    return img.resize((size, size), Image.LANCZOS)

for s in [32, 48, 72, 96, 128, 144, 152, 180, 192, 256, 384, 512, 1024]:
    draw(s).save(f"{OUT}/icon-{s}.png")
for s in [192, 512]:
    draw(s, maskable=True).save(f"{OUT}/maskable-{s}.png")

# Play Store / landing hero: 1024 with room around it.
draw(1024).save(f"{OUT}/icon-hero.png")

# Favicon
draw(32).save(os.path.join(OUT, "..", "favicon.ico"), sizes=[(16,16),(32,32)])
print("icons:", sorted(os.listdir(OUT)))
