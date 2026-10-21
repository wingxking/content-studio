"""Install the canonical lock; an optional public mirror changes transport only."""
import os
import subprocess
from pathlib import Path

path = Path("uv.lock")
original = path.read_text()
mirror = os.environ.get("STUDIO_PYPI_MIRROR", "")
if mirror not in {"", "https://pypi.tuna.tsinghua.edu.cn", "https://mirrors.aliyun.com/pypi"}:
    raise ValueError("Choose a reviewed public wheel mirror or the default PyPI transport.")
try:
    if mirror:
        # Versions, registry authority and wheel SHA-256 hashes remain unchanged.
        path.write_text(original.replace("https://files.pythonhosted.org/packages/", f"{mirror}/packages/"))
    subprocess.run(["uv", "sync", "--frozen", "--no-dev", "--no-install-project", "--python", "/usr/local/bin/python"], check=True)
finally:
    path.write_text(original)
