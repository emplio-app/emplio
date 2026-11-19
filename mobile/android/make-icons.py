"""Draws the Android app's icons from the iPhone icon (white "e" on green). Run when the logo changes; the results are
committed, so a normal build doesn't need Pillow:  python3 make-icons.py
Writes launcher icons (adaptive + older phones), the notification icon, the splash mark, and the Play Store icon."""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "app", "src", "main", "res")
SRC = Image.open(os.path.join(HERE, "..", "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png")).convert("RGB")
GREEN = SRC.getpixel((10, 10))
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}

# the "e" alone: white where the icon is white, see-through elsewhere, cropped to its edges
lum = SRC.convert("L").point(lambda v: 0 if v < 110 else min(255, (v - 110) * 255 // (255 - 110)))
mark = Image.new("RGBA", SRC.size, (255, 255, 255, 0))
mark.putalpha(lum)
mark = mark.crop(lum.getbbox())

def centred(size, share):
    """The mark at `share` of a see-through square's width."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    w = round(size * share)
    h = round(mark.height * w / mark.width)
    canvas.alpha_composite(mark.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2))
    return canvas

def save(img, folder, name):
    os.makedirs(os.path.join(RES, folder), exist_ok=True)
    img.save(os.path.join(RES, folder, name))

for d, k in DENSITIES.items():
    # adaptive icon: 108dp layer, of which a 66dp circle is always visible; the mark keeps well inside it
    save(centred(round(108 * k), 0.40), f"mipmap-{d}", "ic_launcher_foreground.png")
    # phones before Android 8: the whole square icon, and a round one
    full = SRC.resize((round(48 * k),) * 2, Image.LANCZOS)
    save(full, f"mipmap-{d}", "ic_launcher.png")
    round_mask = Image.new("L", (full.width * 4,) * 2, 0)
    ImageDraw.Draw(round_mask).ellipse((0, 0, full.width * 4 - 1, full.width * 4 - 1), fill=255)
    rnd = full.convert("RGBA")
    rnd.putalpha(round_mask.resize(full.size, Image.LANCZOS))
    save(rnd, f"mipmap-{d}", "ic_launcher_round.png")
    # status bar: white on see-through, 24dp with the usual 2dp edge
    save(centred(round(24 * k), 20 / 24), f"drawable-{d}", "ic_notification.png")
    # splash (Android 12 and later draw it inside a 160dp circle; older phones centre it on green)
    save(centred(round(160 * k), 0.40), f"drawable-{d}", "splash_mark.png")

SRC.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, "play-icon-512.png"))
print("green", "#%02x%02x%02x" % GREEN)
