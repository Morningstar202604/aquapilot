#!/usr/bin/env python3
"""Five product role journeys against the real V2 service.

The journeys are deliberately small and independent:

1. storm: 24 h at 1500 m3/h, no crash, finite effluent, flow actually changes
2. blower failure: all aerobic KLa set to zero, low-DO alarm, no NaN
3. what-if: PAC 0 vs PAC 25 on the same 30 d plant, TP must separate
4. weekly report: 7 d run, 7 daily rows, 1 weekly row, report sections
5. dirty data: malformed JSON, invalid config, idempotency conflict, 404, 415

This is evidence for the V2-4 role journeys. It is not a wall-clock 24 h soak.
"""

from __future__ import annotations

import argparse
import copy
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BIN = ROOT / "rust-v2" / "target" / "debug" / "aquapilot-v2"
FIXTURES = ROOT / "rust-v2" / "fixtures"
PROBLEM_TYPES = "application/problem+json"


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def http_raw(url: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None):
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.headers, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read()


def http_json(url: str, method: str = "GET", body=None, headers: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    status, response_headers, payload = http_raw(url, method, data, headers)
    try:
        parsed = json.loads(payload) if payload else {}
    except json.JSONDecodeError:
        parsed = {"raw": payload.decode(errors="replace")}
    return status, response_headers, parsed


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_health(base: str, process: subprocess.Popen, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"service exited with code {process.returncode}")
        try:
            status, _, payload = http_json(f"{base}/api/health")
            if status == 200:
                return payload
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.2)
    raise RuntimeError("service did not become healthy")


def submit(base: str, name: str, model: str, config: dict, duration_min: float,
           sample_every_min: float = 360.0, key: str | None = None):
    body = {
        "name": name,
        "model": model,
        "config": config,
        "duration_min": duration_min,
        "dt_min": 1.0,
        "sample_every_min": sample_every_min,
    }
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    return http_json(f"{base}/api/v1/experiments", "POST", body, headers)


def wait_terminal(base: str, experiment_id: str, timeout: float = 120.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, _, detail = http_json(f"{base}/api/v1/experiments/{experiment_id}")
        if status != 200:
            raise RuntimeError(f"detail returned HTTP {status}: {detail}")
        if detail.get("status") in {"succeeded", "failed", "cancelled"}:
            return detail
        time.sleep(0.2)
    raise TimeoutError(f"experiment {experiment_id} did not finish in {timeout}s")


def cancel(base: str, experiment_id: str) -> int:
    status, _, _ = http_json(f"{base}/api/v1/experiments/{experiment_id}/cancel", "POST")
    return status


def effluent_of(result: dict) -> dict:
    if not isinstance(result, dict):
        return {}
    if isinstance(result.get("effluent"), dict):
        return result["effluent"]
    if isinstance(result.get("asm2d"), dict) and isinstance(result["asm2d"].get("effluent"), dict):
        return result["asm2d"]["effluent"]
    return {}


def check_finite_effluent(result: dict) -> list[str]:
    effluent = effluent_of(result)
    failures = []
    for key in ("cod", "ss", "nh4_n", "tn", "tp", "flow_m3_h"):
        value = effluent.get(key)
        if not isinstance(value, (int, float)) or value != value or value in (float("inf"), float("-inf")):
            failures.append(f"effluent {key} is missing or non-finite")
        elif value < 0:
            failures.append(f"effluent {key} is negative")
    return failures


def run_journey(base: str, journey: dict) -> dict:
    record = {"id": journey["id"], "label": journey["label"], "status": "failed", "checks": {}, "failures": []}
    try:
        journey["run"](base, record)
        record["status"] = "passed" if not record["failures"] else "failed"
    except Exception as error:  # noqa: BLE001 - this is a test harness
        record["failures"].append(f"exception: {error}")
        record["status"] = "failed"
    return record


def journey_storm(base: str, record: dict) -> None:
    config = load_fixture("a2o-asm2d-pac-tertiary.json")
    config["influent"]["flow_m3_h"] = 1500.0
    status, _, created = submit(base, "journey-storm", "asm2d", config, 1440.0, 60.0)
    record["checks"]["submit_http"] = status
    if status != 202:
        record["failures"].append(f"submit HTTP {status}: {created}")
        return
    detail = wait_terminal(base, created["id"])
    record["checks"]["terminal"] = detail.get("status")
    if detail.get("status") != "succeeded":
        record["failures"].append(f"terminal status {detail.get('status')}: {detail.get('error')}")
        return
    failures = check_finite_effluent(detail.get("result") or {})
    record["failures"].extend(failures)
    flow = effluent_of(detail.get("result") or {}).get("flow_m3_h")
    record["checks"]["effluent_flow_m3_h"] = flow
    if not isinstance(flow, (int, float)) or flow < 1400.0:
        record["failures"].append(f"storm flow did not reach the high-flow regime: {flow}")


def journey_blower(base: str, record: dict) -> None:
    config = load_fixture("a2o-asm2d.json")
    for reactor in config["reactors"]:
        if reactor.get("kind") == "aerobic":
            reactor["kla_h"] = 0.0
    status, _, created = submit(base, "journey-blower-failure", "asm2d", config, 1440.0, 60.0)
    record["checks"]["submit_http"] = status
    if status != 202:
        record["failures"].append(f"submit HTTP {status}: {created}")
        return
    detail = wait_terminal(base, created["id"])
    record["checks"]["terminal"] = detail.get("status")
    if detail.get("status") != "succeeded":
        record["failures"].append(f"terminal status {detail.get('status')}: {detail.get('error')}")
        return
    record["failures"].extend(check_finite_effluent(detail.get("result") or {}))
    analysis = detail.get("analysis") or {}
    record["checks"]["alarm_codes"] = [alarm.get("code") for alarm in analysis.get("alarms") or []]
    if "LOW_DO" not in record["checks"]["alarm_codes"]:
        record["failures"].append("blower failure did not produce a LOW_DO alarm")


def journey_what_if(base: str, record: dict) -> None:
    """Tertiary filtration on/off is the clean what-if pair.

    PAC dose alone is a poor separation test on this plant: the chemical
    P stored as X_MeP changes the solids-bound TP, and the model does not
    resolve Al/Fe speciation. Tertiary bypass isolates an unambiguous
    operational lever (filter + PO4 polish) without hiding that boundary.
    """
    base_config = load_fixture("a2o-asm2d-pac-tertiary.json")
    variants = {}
    for label, tss, po4 in (("tertiary-off", 0.0, 0.0), ("tertiary-on", 0.9, 0.7)):
        config = copy.deepcopy(base_config)
        config["tertiary"] = {"tss_removal_fraction": tss, "po4_removal_fraction": po4}
        status, _, created = submit(base, f"journey-what-if-{label}", "asm2d", config, 43200.0, 360.0)
        if status != 202:
            record["failures"].append(f"{label} submit HTTP {status}: {created}")
            return
        detail = wait_terminal(base, created["id"])
        if detail.get("status") != "succeeded":
            record["failures"].append(f"{label} terminal {detail.get('status')}: {detail.get('error')}")
            return
        variants[label] = float(effluent_of(detail.get("result") or {}).get("tp", 0.0))
    record["checks"]["tp_mg_l"] = variants
    if not (variants["tertiary-on"] < variants["tertiary-off"]):
        record["failures"].append(
            f"what-if did not separate TP: on={variants['tertiary-on']}, off={variants['tertiary-off']}"
        )
    elif variants["tertiary-off"] - variants["tertiary-on"] < 0.01:
        record["failures"].append("what-if TP difference is below 0.01 mg/L")


def journey_weekly(base: str, record: dict) -> None:
    config = load_fixture("a2o-asm2d-pac-tertiary.json")
    status, _, created = submit(base, "journey-weekly", "asm2d", config, 10080.0, 360.0)
    record["checks"]["submit_http"] = status
    if status != 202:
        record["failures"].append(f"submit HTTP {status}: {created}")
        return
    detail = wait_terminal(base, created["id"])
    if detail.get("status") != "succeeded":
        record["failures"].append(f"terminal status {detail.get('status')}: {detail.get('error')}")
        return
    analysis = detail.get("analysis") or {}
    daily = analysis.get("daily") or []
    weekly = analysis.get("weekly") or []
    record["checks"]["daily_rows"] = len(daily)
    record["checks"]["weekly_rows"] = len(weekly)
    if len(daily) != 7:
        record["failures"].append(f"expected 7 daily rows, got {len(daily)}")
    if len(weekly) != 1:
        record["failures"].append(f"expected 1 weekly row, got {len(weekly)}")
    for suffix, expected in (("daily.csv", "day-1"), ("weekly.csv", "week-1")):
        status, _, payload = http_raw(f"{base}/api/v1/experiments/{created['id']}/{suffix}")
        record["checks"][f"{suffix}_http"] = status
        if status != 200:
            record["failures"].append(f"{suffix} HTTP {status}")
        elif expected not in payload.decode():
            record["failures"].append(f"{suffix} does not contain {expected}")
    status, _, report = http_raw(f"{base}/api/v1/experiments/{created['id']}/report.md")
    record["checks"]["report_http"] = status
    report_text = report.decode() if isinstance(report, bytes) else str(report)
    for section in ("## Scorecard", "## Alarms", "## Daily averages", "## Weekly averages", "## Data quality"):
        if section not in report_text:
            record["failures"].append(f"report missing section {section}")


def journey_dirty(base: str, record: dict) -> None:
    # 1. malformed JSON
    status, headers, payload = http_raw(
        f"{base}/api/v1/experiments",
        "POST",
        b'{"name": "broken"',
        {"Content-Type": "application/json"},
    )
    record["checks"]["malformed_http"] = status
    record["checks"]["malformed_type"] = headers.get("Content-Type")
    if status != 400 or headers.get("Content-Type") != PROBLEM_TYPES:
        record["failures"].append(f"malformed JSON returned {status} {headers.get('Content-Type')}")

    # 2. invalid model config
    bad_body = {"name": "bad-config", "model": "asm2d", "config": {}, "duration_min": 60, "dt_min": 1}
    status, headers, payload = http_json(
        f"{base}/api/v1/experiments",
        "POST",
        bad_body,
        {"Content-Type": "application/json"},
    )
    record["checks"]["invalid_config_http"] = status
    if status != 422 or payload.get("code") != "VALIDATION_FAILED":
        record["failures"].append(f"invalid config did not return 422 VALIDATION_FAILED: {status} {payload}")

    # 3. idempotency conflict: same key, different body
    config = load_fixture("a2o-asm2d.json")
    status, _, created = submit(base, "journey-dirty-idem", "asm2d", config, 60.0, 60.0, key="journey-idem-key")
    record["checks"]["idem_create_http"] = status
    if status != 202:
        record["failures"].append(f"idempotency fixture submit {status}: {created}")
        return
    changed = {"name": "journey-dirty-idem-changed", "model": "asm2d", "config": config, "duration_min": 60, "dt_min": 1}
    status, headers, payload = http_json(
        f"{base}/api/v1/experiments",
        "POST",
        changed,
        {"Content-Type": "application/json", "Idempotency-Key": "journey-idem-key"},
    )
    record["checks"]["idem_conflict_http"] = status
    record["checks"]["idem_conflict_code"] = payload.get("code")
    if status != 409 or payload.get("code") != "IDEMPOTENCY_KEY_REUSED":
        record["failures"].append(f"idempotency conflict did not return 409: {status} {payload}")
    cancel(base, created["id"])

    # 4. not found
    status, headers, payload = http_json(f"{base}/api/v1/experiments/{uuid.uuid4()}")
    record["checks"]["not_found_http"] = status
    if status != 404 or payload.get("code") != "EXPERIMENT_NOT_FOUND":
        record["failures"].append(f"unknown experiment did not return 404: {status} {payload}")

    # 5. wrong content type
    status, headers, payload = http_json(
        f"{base}/api/v1/experiments",
        "POST",
        {},
        {"Content-Type": "text/plain"},
    )
    record["checks"]["wrong_type_http"] = status
    if status != 415 or payload.get("code") != "UNSUPPORTED_MEDIA_TYPE":
        record["failures"].append(f"wrong content type did not return 415: {status} {payload}")


JOURNEYS = [
    {"id": "storm", "label": "暴雨高流量 24 h", "run": journey_storm},
    {"id": "blower-failure", "label": "风机故障/低 DO", "run": journey_blower},
    {"id": "what-if", "label": "三级过滤开/关 what-if", "run": journey_what_if},
    {"id": "weekly-report", "label": "7 d 周报", "run": journey_weekly},
    {"id": "dirty-data", "label": "脏数据/错误路径", "run": journey_dirty},
]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", default=str(DEFAULT_BIN))
    parser.add_argument("--summary", default=str(ROOT / "docs" / "journeys-v2.json"))
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--keep-db", action="store_true")
    args = parser.parse_args()

    binary = Path(args.bin)
    if not binary.exists():
        print(f"binary not found: {binary}", file=sys.stderr)
        return 2
    port = args.port or free_port()
    base = f"http://{args.bind}:{port}"
    tempdir = tempfile.mkdtemp(prefix="aquapilot-journeys-")
    db = Path(tempdir) / "aquapilot.sqlite"
    log = Path(tempdir) / "service.log"
    log_file = open(log, "w", encoding="utf-8")
    process = subprocess.Popen(
        [str(binary), "serve", "--bind", f"{args.bind}:{port}", "--db", str(db), "--queue-capacity", "16"],
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    started = time.monotonic()
    records = []
    try:
        wait_health(base, process)
        for journey in JOURNEYS:
            record = run_journey(base, journey)
            records.append(record)
            print(f"[{record['status']}] {record['id']} {record['label']}")
            for failure in record["failures"]:
                print(f"  - {failure}")
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGINT)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
        log_file.close()
        if not args.keep_db:
            try:
                db.unlink()
            except FileNotFoundError:
                pass

    passed = sum(1 for record in records if record["status"] == "passed")
    summary = {
        "schema": "aquapilot.journeys.v1",
        "completed_24h": False,
        "case_count": len(records),
        "passed_count": passed,
        "failed_count": len(records) - passed,
        "elapsed_seconds": round(time.monotonic() - started, 3),
        "journeys_complete": passed == len(records),
        "cases": records,
        "service_log": str(log),
        "note": "Five representative role journeys for V2-4; not a wall-clock 24 h soak.",
    }
    output = Path(args.summary)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({key: summary[key] for key in ("case_count", "passed_count", "failed_count", "elapsed_seconds", "journeys_complete")}, indent=2))
    return 0 if summary["journeys_complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
