"""Prepare the files served by the static web edition."""

from pathlib import Path
from shutil import copy2, copytree


def build():
    root = Path(__file__).resolve().parent
    out = root / "dist"
    out.mkdir(exist_ok=True)
    for name in ("index.html", "ladder.html"):
        page = (root / name).read_text(encoding="utf-8")
        if 'data-backend="server"' not in page:
            raise ValueError(f"Missing backend marker in {name}")
        (out / name).write_text(page.replace('data-backend="server"', 'data-backend="static"'), encoding="utf-8")
    for name in ("ui.js", "theme.js", "style.css", "planner-worker.js", "ladder-worker.js", "units.json", "traits.json", "emblems.json", "ladder-plans.json"):
        copy2(root / name, out / name)
    copytree(root / "assets", out / "assets", dirs_exist_ok=True)


if __name__ == "__main__":
    build()
