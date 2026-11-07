"""Build root README from canonical docs/README.md for GitHub rendering.

Do not manually edit the generated root README. Update docs/README.md first.
"""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
source = (ROOT / "docs/README.md").read_text(encoding="utf-8")

def relink(match):
    label, url = match.group(1), match.group(2)
    if url.startswith(("http://", "https://", "mailto:", "#")):
        return match.group(0)
    if url.startswith("../"):
        return f"[{label}]({url[3:]})"
    if (ROOT / "docs" / url.split("#", 1)[0]).exists():
        return f"[{label}](docs/{url})"
    return match.group(0)

result = re.sub(r"\[([^\]\n]+)\]\(([^)]+)\)", relink, source)
(ROOT / "README.md").write_text(result, encoding="utf-8")
print("Root README synchronized with docs/README.md")
