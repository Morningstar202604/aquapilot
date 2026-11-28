#!/usr/bin/env python3
"""Soak-test the AquaPilot V2 Rust service.

The script starts `aquapilot-v2 serve`, submits short experiments at a fixed
interval, samples health/RSS/fd, and writes a machine-readable summary. A 24 h
run is requested with:

    python3 scripts/soak_v2.py --duration 86400 --interval 30

The default 60 s run is a smoke test, not a 24 h acceptance run.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BIN = ROOT / "rust-v2" / "target" / "debug" / "aquapilot-v2"
DEFAULT_FIXTURE = ROOT / "rust-v2" / "fixtures" / "bsm1-official.json"


def http_json(url: str, method: str = "GET", body: bytes | None = None, headers: dict | None = None):
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read()
        return error.code, json.loads(payload) if payload else {}


def post_experiment(base: str, fixture: dict, sequence: int) -> tuple[int, dict | None]:
    body = json.dumps(
        {
            "name": f"soak-{sequence}",
            "model": "asm1",
            "config": fixture,
            "duration_min": 120,
            "dt_min": 1,
            "sample_every_min": 30,
        }
    ).encode()
    status, payload = http_json(
        f"{base}/api/v1/experiments",
        method="POST",
        body=body,
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": f"soak-{os.getpid()}-{sequence}",
        },
    )
    return status, payload


def read_process_metrics(pid: int) -> tuple[int, int]:
    rss_kb = 0
    fds = 0
    try:
        status = Path(f"/proc/{pid}/status").read_text()
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                rss_kb = int(line.split()[1])
                break
    except OSError:
        pass
    try:
        fds = len(list(Path(f"/proc/{pid}/fd").iterdir()))
    except OSError:
        pass
    return rss_kb, fds


def wait_health(base: str, process: subprocess.Popen, timeout: float = 15.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"service exited with code {process.returncode}")
        try:
            status, payload = http_json(f"{base}/api/health")
            if status == 200:
                return payload
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.25)
    raise RuntimeError("service did not become healthy")


def list_all_experiments(base: str) -> list[dict]:
    items: list[dict] = []
    cursor = ""
    while True:
        query = "limit=100"
        if cursor:
            query += f"&cursor={cursor}"
        _, page = http_json(f"{base}/api/v1/experiments?{query}")
        items.extend(page.get("items", []))
        cursor = page.get("next_cursor") or ""
        if not cursor:
            break
    return items


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration", type=float, default=60.0, help="soak seconds")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between submit attempts")
    parser.add_argument("--bind", default="127.0.0.1:5199")
    parser.add_argument("--bin", type=Path, default=DEFAULT_BIN)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--summary", type=Path, default=ROOT / "docs" / "soak-smoke-summary.json")
    parser.add_argument("--keep-db", action="store_true")
    parser.add_argument("--workdir", type=Path, default=None, help="persistent run directory; default is a temp dir")
    parser.add_argument("--progress", type=Path, default=None, help="periodic progress JSON; default is <summary>.progress.json")
    args = parser.parse_args()

    if not args.bin.exists():
        print(f"missing binary: {args.bin}", file=sys.stderr)
        return 2
    fixture = json.loads(args.fixture.read_text())
    if args.workdir:
        args.workdir.mkdir(parents=True, exist_ok=True)
        workdir = args.workdir
    else:
        workdir = Path(tempfile.mkdtemp(prefix="aquapilot-soak-"))
    db_path = workdir / "aquapilot.sqlite"
    log_path = workdir / "service.log"
    log_file = log_path.open("w")
    port = int(args.bind.rsplit(":", 1)[1])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    process = subprocess.Popen(
        [str(args.bin), "serve", "--bind", args.bind, "--db", str(db_path)],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env={**os.environ, "RUST_LOG": "info"},
    )
    base = f"http://{args.bind}"
    started = time.time()
    progress_path = args.progress or args.summary.with_name(args.summary.stem + ".progress.json")
    last_progress = 0.0
    create_latencies: list[float] = []
    submitted = 0
    accepted = 0
    replayed = 0
    queue_full = 0
    request_failures = 0
    health_failures = 0
    max_rss_kb = 0
    max_fds = 0

    def write_progress() -> None:
        if not progress_path:
            return
        try:
            progress_path.parent.mkdir(parents=True, exist_ok=True)
            progress_path.write_text(json.dumps({
                "schema": "aquapilot.soak.progress.v1",
                "requested_duration_seconds": args.duration,
                "started_at_unix": int(started),
                "elapsed_seconds": round(time.time() - started, 3),
                "completed_24h": False,
                "binary": str(args.bin),
                "db_path": str(db_path),
                "service_log": str(log_path),
                "submitted": submitted,
                "accepted_202": accepted,
                "replayed_200": replayed,
                "queue_full_429": queue_full,
                "request_failures": request_failures,
                "health_failures": health_failures,
                "max_rss_kb": max_rss_kb,
                "max_open_fds": max_fds,
                "service_alive": process.poll() is None,
                "note": "periodic checkpoint; final summary is written only when the soak completes",
            }, indent=2, ensure_ascii=False) + "\n")
        except OSError:
            pass

    try:
        health = wait_health(base, process)
        print(f"service healthy: {health}")
        deadline = time.monotonic() + args.duration
        sequence = 0
        while time.monotonic() < deadline:
            sequence += 1
            submitted += 1
            begin = time.perf_counter()
            try:
                status, _ = post_experiment(base, fixture, sequence)
                create_latencies.append((time.perf_counter() - begin) * 1000.0)
                if status == 202:
                    accepted += 1
                elif status == 200:
                    replayed += 1
                elif status == 429:
                    queue_full += 1
                else:
                    request_failures += 1
            except (urllib.error.URLError, TimeoutError, ConnectionError, json.JSONDecodeError) as error:
                request_failures += 1
                print(f"submit failed at {sequence}: {error}", file=sys.stderr)
            try:
                http_json(f"{base}/api/health")
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                health_failures += 1
            rss, fds = read_process_metrics(process.pid)
            max_rss_kb = max(max_rss_kb, rss)
            max_fds = max(max_fds, fds)
            if time.monotonic() - last_progress >= 60:
                write_progress()
                last_progress = time.monotonic()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            time.sleep(min(args.interval, remaining))

        elapsed = time.time() - started
        # Give short experiments a moment to drain before the final census.
        time.sleep(min(5.0, max(1.0, args.duration * 0.1)))
        try:
            all_items = list_all_experiments(base)
            status_counts: dict[str, int] = {}
            for item in all_items:
                status_counts[item["status"]] = status_counts.get(item["status"], 0) + 1
        except Exception as error:  # noqa: BLE001 - the summary must still be written
            status_counts = {"census_error": 1}
            print(f"final census failed: {error}", file=sys.stderr)
        rss, fds = read_process_metrics(process.pid)
        max_rss_kb = max(max_rss_kb, rss)
        max_fds = max(max_fds, fds)
        db_bytes = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(db_path) + suffix)
            if candidate.exists():
                db_bytes += candidate.stat().st_size
        latencies = sorted(create_latencies)
        p95 = statistics.quantiles(latencies, n=100)[94] if len(latencies) >= 2 else (latencies[0] if latencies else 0)
        summary = {
            "schema": "aquapilot.soak.v1",
            "requested_duration_seconds": args.duration,
            "elapsed_seconds": round(elapsed, 3),
            "completed_24h": args.duration >= 86400 and elapsed >= 86400,
            "model": "asm1",
            "binary": str(args.bin),
            "db_path": str(db_path),
            "workdir": str(workdir),
            "submitted": submitted,
            "accepted_202": accepted,
            "replayed_200": replayed,
            "queue_full_429": queue_full,
            "request_failures": request_failures,
            "health_failures": health_failures,
            "max_rss_kb": max_rss_kb,
            "max_open_fds": max_fds,
            "create_latency_ms": {
                "count": len(latencies),
                "p50": round(statistics.median(latencies), 3) if latencies else 0,
                "p95": round(p95, 3),
                "max": round(max(latencies), 3) if latencies else 0,
            },
            "final_status_counts": status_counts,
            "db_bytes": db_bytes,
            "db_bytes_note": "main + WAL + SHM",
            "finished_at_unix": int(time.time()),
            "service_log": str(log_path),
        }
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0 if request_failures == 0 and health_failures == 0 and process.poll() is None else 1
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        log_file.close()
        if not args.keep_db:
            # Keep the SQLite file only when requested; the summary records its path.
            for suffix in ("", "-wal", "-shm"):
                try:
                    Path(str(db_path) + suffix).unlink()
                except OSError:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
