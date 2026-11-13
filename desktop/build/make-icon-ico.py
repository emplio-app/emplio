"""Draws the Windows app's icon (icon.ico) from icon-1024.png (made by make-assets.py).
Run when the logo changes:
  python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow && /tmp/v/bin/python make-icon-ico.py
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = [16, 24, 32, 48, 64, 128, 256]

if __name__ == "__main__":
    img = Image.open(os.path.join(HERE, "icon-1024.png")).convert("RGBA")
    img.save(os.path.join(HERE, "icon.ico"), sizes=[(s, s) for s in SIZES])
    print("icon.ico written")
