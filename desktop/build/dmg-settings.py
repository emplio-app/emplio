# The installer window (dmgbuild: https://dmgbuild.readthedocs.io). Positions match the arrow drawn in background.tiff (make-assets.py).
import os

here = os.path.dirname(defines["settings"])  # noqa: F821
app = defines["app"]  # noqa: F821

format = "UDZO"
size = None
files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(here, "icon.icns")
background = os.path.join(here, "background.tiff")
window_rect = ((200, 140), (660, 420))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 128
text_size = 13
arrange_by = None
icon_locations = {os.path.basename(app): (180, 200), "Applications": (480, 200)}
