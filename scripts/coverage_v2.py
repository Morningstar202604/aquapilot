#!/usr/bin/env python3
"""Representative end-to-end coverage matrix for the AquaPilot V2 service.

This is the "small representative sample" gate: every model kind, every
whole-plant boundary, and a set of operating disturbances are submitted to
the same persistent queue used by the UI. It supplements, but does not
replace, the wall-clock 24 h soak.

Run after building `rust-v2`:

    python3 scripts/coverage_v2.py --summary docs/coverage-matrix.json

The script starts its own service on a free port with a temporary SQLite DB,
drives each case through the public HTTP API, checks the experiment detail,
CSV, Markdown report and mass balance where the model emits one, then exits
non-zero if any representative case fails.
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


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def http_json(url: str, method: str = "GET", body: dict | None = None, headers: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            parsed = {"raw": payload.decode(errors="replace")}
        return error.code, parsed


def http_bytes(url: str) -> tuple[int, bytes]:
    request = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def wait_health(base: str, process: subprocess.Popen, timeout: float = 20.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"service exited with code {process.returncode}")
        try:
            status, payload = http_json(f"{base}/api/health")
            if status == 200:
                return payload
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.25)
    raise RuntimeError("service did not become healthy")


def post_case(base: str, case: dict) -> tuple[int, dict]:
    body = {
        "name": f"coverage-{case['id']}-{int(time.time())}",
        "model": case["model"],
        "config": case["config"],
        "duration_min": case["duration_min"],
        "dt_min": case.get("dt_min", 1.0),
        "sample_every_min": case.get("sample_every_min", 360.0),
        "sludge_days": case.get("sludge_days", 30.0),
        "sludge_dt_days": case.get("sludge_dt_days", 0.002),
    }
    if "max_iterations" in case:
        body["max_iterations"] = case["max_iterations"]
    if "relaxation" in case:
        body["relaxation"] = case["relaxation"]
    return http_json(
        f"{base}/api/v1/experiments",
        method="POST",
        body=body,
        headers={
            "Content-Type": "application/json",
            "Idempotency-Key": f"coverage-{uuid.uuid4()}",
        },
    )


def wait_terminal(base: str, experiment_id: str, timeout: float = 90.0) -> tuple[dict, float]:
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        status, detail = http_json(f"{base}/api/v1/experiments/{experiment_id}")
        if status != 200:
            raise RuntimeError(f"detail returned HTTP {status}: {detail}")
        if detail.get("status") in {"succeeded", "failed", "cancelled"}:
            return detail, time.monotonic() - started
        time.sleep(0.25)
    raise TimeoutError(f"experiment {experiment_id} did not reach a terminal status in {timeout}s")


def recursively_find_balance(value):
    if isinstance(value, dict):
        for key in ("whole_balance", "mass_balance"):
            if key in value and isinstance(value[key], dict):
                return value[key]
        for child in value.values():
            found = recursively_find_balance(child)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = recursively_find_balance(child)
            if found is not None:
                return found
    return None


def balance_residuals(result: dict) -> list[float]:
    balance = recursively_find_balance(result)
    if not balance:
        return []
    residuals = []
    for key, item in balance.items():
        if not isinstance(item, dict):
            continue
        for field in ("residual", "residual_fraction", "closure_fraction"):
            if field in item and isinstance(item[field], (int, float)):
                residuals.append(abs(float(item[field])))
                break
    return residuals


def effluent_of(result: dict) -> dict:
    if not isinstance(result, dict):
        return {}
    if isinstance(result.get("effluent"), dict):
        return result["effluent"]
    if isinstance(result.get("asm2d"), dict) and isinstance(result["asm2d"].get("effluent"), dict):
        return result["asm2d"]["effluent"]
    return {}


def numeric_effluent(effluent: dict, keys: list[str]) -> dict:
    values = {}
    for key in keys:
        value = effluent.get(key)
        if isinstance(value, (int, float)):
            values[key] = float(value)
    return values


def run_case(base: str, case: dict) -> dict:
    record = {
        "id": case["id"],
        "label": case["label"],
        "model": case["model"],
        "duration_min": case["duration_min"],
        "channel": case["channel"],
        "status": "failed",
        "failures": [],
        "checks": {},
    }
    started = time.monotonic()
    try:
        status, created = post_case(base, case)
        record["submit_http"] = status
        if status != 202:
            record["failures"].append(f"submit HTTP {status}: {created}")
            return record
        experiment_id = created["id"]
        record["experiment_id"] = experiment_id
        detail, wait_seconds = wait_terminal(base, experiment_id, timeout=case.get("timeout", 90.0))
        record["status"] = detail.get("status")
        record["wait_seconds"] = round(wait_seconds, 3)
        record["progress"] = detail.get("progress")
        if detail.get("status") != "succeeded":
            record["failures"].append(f"terminal status: {detail.get('status')} {detail.get('error')}")
            return record

        result = detail.get("result") or {}
        effluent = effluent_of(result)
        if case["model"] in {"asm1", "asm2d", "asm2d-adm1-loop"}:
            expected = ["cod", "nh4_n", "tn", "tp", "ss"] if case["model"] != "asm1" else ["cod", "nh4_n", "tn", "ss"]
            values = numeric_effluent(effluent, expected)
            record["checks"]["effluent_fields"] = values
            missing = [key for key in expected if key not in values]
            if missing:
                record["failures"].append(f"missing effluent fields: {missing}")
            if any(value < 0 for value in values.values()):
                record["failures"].append("effluent contains a negative value")

        residuals = balance_residuals(result)
        record["checks"]["balance_residuals"] = [round(value, 6) for value in residuals]
        if residuals and max(residuals) > 0.05:
            record["failures"].append(f"mass balance residual > 5%: {max(residuals):.4f}")
        if case["model"] == "asm2d-adm1-loop" and not residuals:
            record["failures"].append("loop result is missing whole_balance")

        csv_status, csv = http_bytes(f"{base}/api/v1/experiments/{experiment_id}/samples.csv")
        record["checks"]["csv_http"] = csv_status
        if csv_status != 200:
            record["failures"].append(f"samples.csv HTTP {csv_status}")
        else:
            lines = [line for line in csv.decode(errors="replace").splitlines() if line.strip()]
            record["checks"]["csv_rows"] = max(0, len(lines) - 1)
            record["checks"]["csv_header"] = lines[0][:240] if lines else ""
            if len(lines) < 2 or "minute" not in lines[0]:
                record["failures"].append("samples.csv has no data rows or minute header")

        report_status, report = http_bytes(f"{base}/api/v1/experiments/{experiment_id}/report.md")
        record["checks"]["report_http"] = report_status
        record["checks"]["report_bytes"] = len(report)
        if report_status != 200:
            record["failures"].append(f"report.md HTTP {report_status}")
        elif len(report) < 120:
            record["failures"].append("report.md is unexpectedly short")

        record["elapsed_seconds"] = round(time.monotonic() - started, 3)
        return record
    except Exception as error:  # noqa: BLE001 - each case must be recorded independently
        record["failures"].append(f"{type(error).__name__}: {error}")
        record["elapsed_seconds"] = round(time.monotonic() - started, 3)
        return record


def build_cases() -> list[dict]:
    basic = load_fixture("a2o-asm2d.json")
    pac = load_fixture("a2o-asm2d-pac-tertiary.json")
    bsm1 = load_fixture("bsm1-official.json")
    adm1 = load_fixture("adm1-tutorial.json")
    sludge = load_fixture("adm1-sludge-line.json")
    cases: list[dict] = [
        {
            "id": "asm1-bsm1",
            "label": "ASM1 / BSM1 基准 1 天",
            "model": "asm1",
            "channel": "model",
            "config": bsm1,
            "duration_min": 1440,
            "dt_min": 1,
            "sample_every_min": 60,
        },
        {
            "id": "asm2d-basic",
            "label": "ASM2d A2O 基础 30 天",
            "model": "asm2d",
            "channel": "model",
            "config": basic,
            "duration_min": 43200,
            "sample_every_min": 360,
        },
        {
            "id": "asm2d-pac-tertiary",
            "label": "ASM2d PAC + 三级过滤 30 天",
            "model": "asm2d",
            "channel": "model",
            "config": pac,
            "duration_min": 43200,
            "sample_every_min": 360,
        },
        {
            "id": "asm2d-loop",
            "label": "ASM2d + ADM1 回流闭环 30 天",
            "model": "asm2d-adm1-loop",
            "channel": "model",
            "config": {"plant": copy.deepcopy(pac)},
            "duration_min": 43200,
            "sample_every_min": 360,
            "sludge_days": 30,
            "sludge_dt_days": 0.005,
            "max_iterations": 6,
            "relaxation": 0.5,
            "timeout": 120,
        },
        {
            "id": "adm1-tutorial",
            "label": "ADM1 消化器 10 天",
            "model": "adm1",
            "channel": "model",
            "config": adm1,
            "duration_min": 14400,
            "sample_every_min": 1440,
            "sludge_dt_days": 0.005,
        },
        {
            "id": "sludge-line",
            "label": "完整泥线 20 天",
            "model": "sludge-line",
            "channel": "model",
            "config": sludge,
            "duration_min": 28800,
            "sample_every_min": 2880,
            "sludge_dt_days": 0.005,
        },
    ]

    def mutated(mutator):
        config = copy.deepcopy(pac)
        mutator(config)
        return config

    cases.extend(
        [
            {
                "id": "scenario-high-flow",
                "label": "工况：高流量 1500 m3/h",
                "model": "asm2d",
                "channel": "scenario",
                "config": mutated(lambda c: c["influent"].__setitem__("flow_m3_h", 1500)),
                "duration_min": 43200,
                "sample_every_min": 360,
            },
            {
                "id": "scenario-low-do",
                "label": "工况：好氧 DO 1.0 / KLa 120",
                "model": "asm2d",
                "channel": "scenario",
                "config": mutated(lambda c: [r.update(kla_h=120, do_setpoint=1.0) for r in c["reactors"] if r["kind"] == "aerobic"]),
                "duration_min": 43200,
                "sample_every_min": 360,
            },
            {
                "id": "scenario-winter",
                "label": "工况：冬季 12 °C",
                "model": "asm2d",
                "channel": "scenario",
                "config": mutated(lambda c: [r.__setitem__("temperature_c", 12) for r in c["reactors"]]),
                "duration_min": 43200,
                "sample_every_min": 360,
            },
            {
                "id": "scenario-pac-off",
                "label": "工况：PAC 停加",
                "model": "asm2d",
                "channel": "scenario",
                "config": mutated(lambda c: c["pac"].__setitem__("dose_mg_l", 0)),
                "duration_min": 43200,
                "sample_every_min": 360,
            },
            {
                "id": "scenario-tertiary-bypass",
                "label": "工况：三级过滤旁路",
                "model": "asm2d",
                "channel": "scenario",
                "config": mutated(lambda c: c["tertiary"].update(tss_removal_fraction=0, po4_removal_fraction=0)),
                "duration_min": 43200,
                "sample_every_min": 360,
            },
        ]
    )
    return cases


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1:5198")
    parser.add_argument("--bin", type=Path, default=DEFAULT_BIN)
    parser.add_argument("--summary", type=Path, default=ROOT / "docs" / "coverage-matrix.json")
    parser.add_argument("--case-timeout", type=float, default=90.0)
    parser.add_argument("--keep-db", action="store_true")
    args = parser.parse_args()

    if not args.bin.exists():
        print(f"missing binary: {args.bin}", file=sys.stderr)
        return 2
    port = int(args.bind.rsplit(":", 1)[1])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", port))
    workdir = Path(tempfile.mkdtemp(prefix="aquapilot-coverage-"))
    db_path = workdir / "aquapilot.sqlite"
    log_path = workdir / "service.log"
    log_file = log_path.open("w")
    process = subprocess.Popen(
        [str(args.bin), "serve", "--bind", args.bind, "--db", str(db_path)],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env={**os.environ, "RUST_LOG": "info"},
    )
    base = f"http://{args.bind}"
    started = time.time()
    cases = build_cases()
    results: list[dict] = []
    try:
        health = wait_health(base, process)
        print(f"service healthy: {health}")
        for index, case in enumerate(cases, 1):
            case["timeout"] = case.get("timeout", args.case_timeout)
            print(f"[{index}/{len(cases)}] {case['label']}")
            result = run_case(base, case)
            results.append(result)
            print(f"  {result['status']} · {result.get('elapsed_seconds', 0):.2f}s · {len(result['failures'])} failure(s)")

        models = sorted({case["model"] for case in cases})
        channels = sorted({case["channel"] for case in cases})
        failures = [case["id"] for case in results if case["status"] != "succeeded" or case["failures"]]
        summary = {
            "schema": "aquapilot.coverage.v1",
            "generated_at_unix": int(time.time()),
            "elapsed_seconds": round(time.time() - started, 3),
            "coverage_complete": not failures,
            "completed_24h": False,
            "bin": str(args.bin),
            "models_covered": models,
            "channels_covered": channels,
            "case_count": len(cases),
            "passed_count": len(results) - len(failures),
            "failed_count": len(failures),
            "failed_case_ids": failures,
            "cases": results,
            "service_log": str(log_path),
            "db_path": str(db_path),
            "note": (
                "Representative end-to-end coverage: every service model plus A2O operating disturbances "
                "through submit → queue → worker → detail → samples.csv → report.md → mass balance. "
                "This is not a wall-clock 24 h soak; completed_24h remains false."
            ),
        }
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(summary, indent=2, ensure_ascii=False))
        return 0 if summary["coverage_complete"] else 1
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
            for suffix in ("", "-wal", "-shm"):
                try:
                    Path(str(db_path) + suffix).unlink()
                except OSError:
                    pass


if __name__ == "__main__":
    raise SystemExit(main())
