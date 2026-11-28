#!/usr/bin/env python3
"""ASM1 free-topology acceptance journey against a running V2 service.

It proves four things the browser canvas relies on:

1. all three ASM1 presets compile through `POST /api/v1/topologies/validate`;
2. a user edit (delete anaerobic + reconnect influent to anoxic) compiles;
3. the edited topology can be submitted as a normal experiment;
4. the result is scored as ASM1-only (four limits), not as a fake ASM2d plant.

This is a product acceptance journey, not a wall-clock 24 h soak.
"""

from __future__ import annotations

import argparse
import copy
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def http_json(base: str, path: str, method: str = "GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload or b"{}")
        except json.JSONDecodeError:
            parsed = {"raw": payload.decode(errors="replace")}
        return error.code, parsed


def wait_terminal(base: str, experiment_id: str, timeout: float = 180.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, detail = http_json(base, f"/api/v1/experiments/{experiment_id}")
        if status != 200:
            raise RuntimeError(f"detail HTTP {status}: {detail}")
        if detail.get("status") in {"succeeded", "failed", "cancelled"}:
            return detail
        time.sleep(0.25)
    raise TimeoutError(f"{experiment_id} did not finish in {timeout}s")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:5192")
    parser.add_argument("--summary", default="docs/topology-journey.json")
    args = parser.parse_args()

    status, presets_doc = http_json(args.base, "/api/v1/presets")
    if status != 200:
        raise SystemExit(f"presets HTTP {status}: {presets_doc}")
    presets = presets_doc["presets"]
    asm1 = [preset for preset in presets if preset["model"] == "asm1"]
    assert {preset["id"] for preset in asm1} >= {"bsm1", "asm1-three-stage", "asm1-single"}

    checks = []
    for preset in asm1:
        code, doc = http_json(args.base, "/api/v1/topologies/validate", "POST", preset["config"])
        checks.append({
            "preset": preset["id"],
            "http": code,
            "units": doc.get("units"),
            "connections": doc.get("connections"),
            "reactors": doc.get("reactors"),
            "clarifiers": doc.get("clarifiers"),
        })
        if code != 200:
            raise SystemExit(f"{preset['id']} failed topology validation: {doc}")

    three = copy.deepcopy(next(preset for preset in asm1 if preset["id"] == "asm1-three-stage")["config"])
    three["units"] = [unit for unit in three["units"] if unit["id"] != "ana"]
    three["connections"] = [
        edge for edge in three["connections"]
        if edge["from"] != "ana" and edge["to"] != "ana"
    ]
    three["connections"].append({
        "id": "in-anx",
        "from": "in",
        "to": "anx",
        "flow_m3_h": 1000.0,
        "stream": "process",
    })
    three["name"] = "three-stage edited: ana removed"
    edited_code, compiled = http_json(args.base, "/api/v1/topologies/validate", "POST", three)
    if edited_code != 200:
        raise SystemExit(f"edited topology failed: HTTP {edited_code} {compiled}")
    assert compiled["units"] == 4 and compiled["connections"] == 3

    body = {
        "name": "topology-journey · ana removed",
        "model": "asm1",
        "config": three,
        "duration_min": 1440.0,
        "dt_min": 1.0,
        "sample_every_min": 60.0,
    }
    code, created = http_json(args.base, "/api/v1/experiments", "POST", body)
    if code not in {200, 202}:
        raise SystemExit(f"submit HTTP {code}: {created}")
    detail = wait_terminal(args.base, created["id"])
    if detail["status"] != "succeeded":
        raise SystemExit(f"experiment status {detail['status']}: {detail.get('error')}")
    analysis = detail.get("analysis") or {}
    scorecard = analysis.get("scorecard") or {}
    alarms = analysis.get("alarms") or []
    if analysis.get("applicability") != "effluent_compliance":
        raise SystemExit(f"ASM1 applicability wrong: {analysis.get('applicability')}")
    if scorecard.get("total") != 4:
        raise SystemExit(f"ASM1 scorecard should have 4 limits: {scorecard}")
    if not any(alarm.get("code") == "EFFLUENT_COD_HIGH" for alarm in alarms):
        raise SystemExit(f"edited topology should expose COD alarm: {alarms}")

    summary = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "base": args.base,
        "presets": checks,
        "edited_topology": {
            "http": edited_code,
            "units": compiled["units"],
            "connections": compiled["connections"],
            "reactors": compiled["reactors"],
            "effluent_flow_m3_h": compiled["effluent_flow_m3_h"],
        },
        "experiment": {
            "id": detail["id"],
            "status": detail["status"],
            "minutes": detail.get("spec", {}).get("duration_min"),
            "grade": scorecard.get("grade"),
            "passed": scorecard.get("passed"),
            "total": scorecard.get("total"),
            "alarms": [alarm.get("code") for alarm in alarms],
            "effluent": (detail.get("result") or {}).get("effluent"),
        },
        "completed_24h": False,
        "note": "Topology acceptance journey only; this is not a wall-clock 24 h soak.",
    }
    path = ROOT / args.summary
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
