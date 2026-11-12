"""Draws the Mac app's icon (icon.icns) and the installer window's background (background.tiff) from the logo.
Run when the logo changes; the results are committed, so a normal build doesn't need Pillow:
  python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow && /tmp/v/bin/python make-assets.py
"""
import math, os, subprocess, tempfile
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
LOGO = os.path.join(HERE, "..", "..", "mobile", "ios", "App", "App", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-512@2x.png")
GREEN = (26, 97, 63)
S = 4  # drawn this much bigger, then shrunk, for clean edges


def squircle(size, n=5.0):
    """Apple's icon outline is a superellipse, not a plain rounded square."""
    big = size * S
    mask = Image.new("L", (big, big), 0)
    px = mask.load()
    r = big / 2
    for y in range(big):
        dy = abs((y + 0.5 - r) / r)
        edge = (1 - dy**n) ** (1 / n) if dy < 1 else 0
        x0, x1 = int(r - edge * r), int(r + edge * r)
        for x in range(max(x0, 0), min(x1, big)):
            px[x, y] = 255
    return mask.resize((size, size), Image.LANCZOS)


def icon():
    src = Image.open(LOGO).convert("RGB").resize((824, 824), Image.LANCZOS)
    body = Image.new("RGBA", (824, 824), (0, 0, 0, 0))
    body.paste(src, (0, 0), squircle(824))
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 90), (100, 112), squircle(824))
    canvas = Image.alpha_composite(canvas, shadow.filter(ImageFilter.GaussianBlur(14)))
    canvas.alpha_composite(body, (100, 100))
    return canvas


def make_icns(img):
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "Emplio.iconset")
        os.mkdir(iconset)
        for size in (16, 32, 128, 256, 512):
            img.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}.png"))
            img.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", os.path.join(HERE, "icon.icns")], check=True)
    img.save(os.path.join(HERE, "icon-1024.png"))


W, H = 660, 420
APP, APPS = (180, 200), (480, 200)  # icon centres, in the window


def background(scale):
    w, h = W * scale, H * scale
    img = Image.new("RGB", (w, h), (251, 250, 248))
    px = ImageDraw.Draw(img, "RGBA")
    # soft green light coming from the bottom corners and a hint at the top (each blob is a blurred mask of one colour,
    # so the blur doesn't dim the colours)
    def blob(box, colour, alpha):
        m = Image.new("L", (w, h), 0)
        ImageDraw.Draw(m).ellipse(box, fill=alpha)
        m = m.filter(ImageFilter.GaussianBlur(70 * scale))
        return Image.new("RGBA", (w, h), colour + (255,)), m
    img = img.convert("RGBA")
    for box, colour, alpha in [
        ((-w * 0.25, h * 0.55, w * 0.45, h * 1.45), (73, 160, 114), 90),
        ((w * 0.55, h * 0.6, w * 1.3, h * 1.5), (26, 97, 63), 70),
        ((w * 0.25, -h * 0.9, w * 0.85, h * 0.25), (214, 235, 223), 150),
    ]:
        layer, m = blob(box, colour, alpha)
        img.paste(layer, (0, 0), m)
    # the logo's "e", very faint, big, behind it all
    logo = Image.open(LOGO).convert("RGB").resize((h, h), Image.LANCZOS)
    e = logo.convert("L").point(lambda v: 255 if v > 200 else 0).filter(ImageFilter.GaussianBlur(1))
    tint = Image.new("RGBA", (h, h), (26, 97, 63, 0))
    tint.putalpha(e.point(lambda v: int(v * 0.045)))
    img.alpha_composite(tint, (int(w * 0.62), int(h * 0.02)))
    d = ImageDraw.Draw(img, "RGBA")
    font = lambda size, path="/System/Library/Fonts/SFNSRounded.ttf": ImageFont.truetype(path, size * scale)
    d.text((w / 2, 62 * scale), "Welcome to Emplio", font=font(26), fill=(22, 62, 43), anchor="mm")
    d.text((w / 2, 94 * scale), "The self-learning AI employee", font=font(14), fill=(96, 112, 103), anchor="mm")
    # a dashed arrow from the app to Applications
    ax0, ay = (APP[0] + 88) * scale, APP[1] * scale
    ax1 = (APPS[0] - 88) * scale
    for i in range(int((ax1 - ax0 - 26 * scale) // (14 * scale)) + 1):
        x = ax0 + i * 14 * scale
        d.rounded_rectangle((x, ay - 2 * scale, x + 8 * scale, ay + 2 * scale), radius=2 * scale, fill=(26, 97, 63, 200))
    d.polygon([(ax1 - 2 * scale, ay), (ax1 - 20 * scale, ay - 11 * scale), (ax1 - 20 * scale, ay + 11 * scale)], fill=(26, 97, 63, 230))
    d.text((w / 2, 330 * scale), "Drag Emplio into the Applications folder", font=font(16), fill=(22, 62, 43), anchor="mm")
    d.text((w / 2, 358 * scale), "then open it from Launchpad or Applications", font=font(12), fill=(120, 134, 126), anchor="mm")
    return img.convert("RGB")


def make_background():
    with tempfile.TemporaryDirectory() as tmp:
        one, two = os.path.join(tmp, "bg.png"), os.path.join(tmp, "bg@2x.png")
        background(1).save(one, dpi=(72, 72))
        background(2).save(two, dpi=(144, 144))
        subprocess.run(["tiffutil", "-cathidpicheck", one, two, "-out", os.path.join(HERE, "background.tiff")], check=True)
    background(1).save(os.path.join(HERE, "background-preview.png"))


if __name__ == "__main__":
    art = icon()
    make_icns(art)
    make_background()
    print("icon.icns, icon-1024.png, background.tiff written")
