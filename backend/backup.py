"""Copy the SQLite database safely while the app runs, and keep the newest N.

    python backup.py /data/backups --label pre-deploy-abc1234 --keep 14

Uses SQLite's online backup API, so the copy is consistent even mid-write.
Restore: stop taskflow_api, copy the backup over /data/taskflow.db, start it.
"""

from __future__ import annotations

import argparse
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings


def db_path() -> Path:
    url = settings.database_url
    if not url.startswith("sqlite:///"):
        raise SystemExit(f"Not a SQLite file URL: {url}")
    return Path(url[len("sqlite:///"):])


def backup(target_dir: Path, label: str, keep: int) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe = re.sub(r"[^A-Za-z0-9._-]", "-", label)[:60] or "manual"
    out = target_dir / f"taskflow-{stamp}-{safe}.db"
    src = sqlite3.connect(db_path())
    dst = sqlite3.connect(out)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    copies = sorted(target_dir.glob("taskflow-*.db"))
    for old in copies[:-keep] if keep > 0 else []:
        old.unlink()
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("target_dir", type=Path)
    parser.add_argument("--label", default="manual")
    parser.add_argument("--keep", type=int, default=14)
    args = parser.parse_args()
    if not db_path().exists():
        print(f"No database at {db_path()} yet; nothing to back up.")
        return
    print(backup(args.target_dir, args.label, args.keep))


if __name__ == "__main__":
    main()
