#!/usr/bin/env python3
"""
Flurry — manifest-driven full capture for PlayFive / $GrandV
Reads data/manifest.json from a ZERO fork, downloads every file from the
live server into a local mirror, then optionally verifies sizes.

Usage:
  python3 flurry.py [--out DIR] [--concurrency N] [--verify] [--dry-run]

Defaults:
  --out          ZEROED/$GrandV/   (extends the existing ZERO fork)
  --concurrency  8
"""

import argparse
import hashlib
import json
import os
import sys
import time
import threading
from pathlib import Path
from queue import Queue, Empty
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

BASE_URL   = "https://v2.fiveplay.lol/data"
MANIFEST   = Path(__file__).parent / "ZEROED/$GrandV/data/manifest.json"
DEFAULT_OUT = Path(__file__).parent / "ZEROED/$GrandV"
VERSION_TAG = "grandv-r5-mobile-core-20261023"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) "
                  "Chrome/131.0.0.0 Safari/537.36",
    "Referer": "https://v2.fiveplay.lol/",
}

# ── progress state ────────────────────────────────────────────────────────────
_lock        = threading.Lock()
_done        = 0
_skipped     = 0
_failed      = 0
_bytes_total = 0
_start_time  = time.monotonic()


def _progress(total_files: int, total_bytes: int) -> None:
    elapsed = time.monotonic() - _start_time
    with _lock:
        d, s, f, bt = _done, _skipped, _failed, _bytes_total
    pct  = (d + s) / total_files * 100 if total_files else 0
    rate = bt / elapsed / 1e6 if elapsed else 0
    bar_w = 30
    filled = int(bar_w * (d + s) / total_files) if total_files else 0
    bar  = "█" * filled + "░" * (bar_w - filled)
    print(
        f"\r[{bar}] {pct:5.1f}%  "
        f"{d+s}/{total_files} files  "
        f"{bt/1e9:.2f}/{total_bytes/1e9:.2f} GB  "
        f"{rate:.1f} MB/s  "
        f"fail={f}   ",
        end="", flush=True,
    )


def download_file(path: str, expected_size: int, out_root: Path, version: str,
                  verify: bool, dry_run: bool) -> str:
    """Download one file. Returns 'ok', 'skip', or 'fail:<reason>'."""
    dest = out_root / "data" / path
    if dest.exists() and dest.stat().st_size == expected_size:
        return "skip"
    if dry_run:
        return "ok"

    dest.parent.mkdir(parents=True, exist_ok=True)
    from urllib.parse import quote
    url = f"{BASE_URL}/{quote(path, safe='/')}?v={version}"
    tmp = dest.with_suffix(dest.suffix + ".part")

    try:
        req = Request(url, headers=HEADERS)
        with urlopen(req, timeout=60) as resp, open(tmp, "wb") as fh:
            while True:
                chunk = resp.read(1 << 17)   # 128 KB
                if not chunk:
                    break
                fh.write(chunk)
                with _lock:
                    global _bytes_total
                    _bytes_total += len(chunk)
        actual = tmp.stat().st_size
        if verify and actual != expected_size:
            tmp.unlink(missing_ok=True)
            return f"fail:size mismatch {actual} != {expected_size}"
        tmp.replace(dest)
        return "ok"
    except (HTTPError, URLError, OSError) as exc:
        tmp.unlink(missing_ok=True)
        return f"fail:{exc}"


def worker(queue: Queue, out_root: Path, version: str, verify: bool,
           dry_run: bool, total_files: int, total_bytes: int,
           failed_log: list) -> None:
    global _done, _skipped, _failed
    while True:
        try:
            path, size = queue.get(timeout=1)
        except Empty:
            return
        result = download_file(path, size, out_root, version, verify, dry_run)
        with _lock:
            if result == "skip":
                _skipped += 1
            elif result == "ok":
                _done += 1
            else:
                _failed += 1
                failed_log.append((path, result))
        _progress(total_files, total_bytes)
        queue.task_done()


def main() -> None:
    ap = argparse.ArgumentParser(description="Flurry: full PlayFive asset capture")
    ap.add_argument("--out", default=str(DEFAULT_OUT),
                    help="Output root (default: ZEROED/$GrandV)")
    ap.add_argument("--concurrency", type=int, default=8,
                    help="Parallel download threads (default: 8)")
    ap.add_argument("--verify", action="store_true",
                    help="Reject files whose size doesn't match the manifest")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print what would be downloaded without fetching")
    ap.add_argument("--manifest", default=str(MANIFEST),
                    help="Path to manifest.json")
    args = ap.parse_args()

    out_root = Path(args.out)
    manifest_path = Path(args.manifest)

    if not manifest_path.exists():
        sys.exit(f"Manifest not found: {manifest_path}\n"
                 "Run `zero fork` first to capture it.")

    with open(manifest_path) as fh:
        manifest = json.load(fh)

    version = manifest.get("version", VERSION_TAG)
    files   = manifest.get("files", [])   # [path, size, mtime]

    total_files = len(files)
    total_bytes = sum(f[1] for f in files)

    print(f"Flurry  —  {total_files:,} files  /  {total_bytes/1e9:.2f} GB")
    print(f"Version : {version}")
    print(f"Output  : {out_root}")
    print(f"Threads : {args.concurrency}")
    if args.dry_run:
        print("DRY RUN — nothing will be written\n")
    print()

    queue: Queue = Queue()
    for path, size, *_ in files:
        queue.put((path, size))

    failed_log: list = []
    threads = [
        threading.Thread(
            target=worker,
            args=(queue, out_root, version, args.verify, args.dry_run,
                  total_files, total_bytes, failed_log),
            daemon=True,
        )
        for _ in range(args.concurrency)
    ]
    global _start_time
    _start_time = time.monotonic()
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    print()  # end progress line
    elapsed = time.monotonic() - _start_time
    print(f"\nDone in {elapsed:.0f}s")
    print(f"  downloaded : {_done:,} files  ({_bytes_total/1e9:.2f} GB)")
    print(f"  skipped    : {_skipped:,} (already present and correct size)")
    print(f"  failed     : {_failed:,}")

    if failed_log:
        log_path = out_root / "flurry_failures.txt"
        with open(log_path, "w") as fh:
            for path, reason in failed_log:
                fh.write(f"{reason}\t{path}\n")
        print(f"\nFailed items written to: {log_path}")
        print("Re-run Flurry to retry (skips already-complete files).")


if __name__ == "__main__":
    main()
