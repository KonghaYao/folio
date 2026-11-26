"""Build one release, exercise fresh browsers and produce a machine-readable report."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

# One independently written receipt from each scenario; a run must regenerate it.
RECEIPTS = {
    "draw": "pen-evidence.json",
    "chat": "chat.json",
    "pen_lab": "pressure-tilt.json",
    "sharing": "collaboration.json",
    "scenes_export": "scenes-export.json",
    "library": "browser-library.json",
    "mobile": "touch-devices.json",
    "device_sync": "device-sync.json",
    "trusted_devices": "trusted-devices.json",
    "offline": "offline-restart.json",
    "offline_delta": "offline-delta.json",
    "offline_conflict": "offline-conflict.json",
    "offline_immediate": "offline-immediate.json",
    "offline_images": "offline-images.json",
    "objects_sync": "objects-sync.json",
    "revocation": "revocation.json",
    "drawing_aids": "drawing-aids.json",
    "presence": "presence-follow.json",
    "media": "media.json",
    "reference_ui": "reference-ui.json",
}
KEYWORD_URL = {"scenes_export", "library", "offline", "offline_conflict", "objects_sync"}


def hash_tree(directory, paths):
    """Include names and byte boundaries in the reproducible tree digest."""
    digest = hashlib.sha256()
    for file in sorted(paths):
        if file.is_file():
            name = file.relative_to(directory).as_posix().encode()
            digest.update(len(name).to_bytes(4, "big"))
            digest.update(name)
            digest.update(hashlib.sha256(file.read_bytes()).digest())
    return digest.hexdigest()


def source_hash(root):
    paths = [
        root / name
        for name in ("package.json", "bun.lock", "index.html", "vite.config.ts", "tsconfig.json")
    ]
    for folder in ("server", "client", "build", "public", "shared", "scripts"):
        paths.extend((root / folder).rglob("*"))
    return hash_tree(root, paths)


def scenario_command(root, case, url, bun):
    if case == "offline_immediate":
        return [
            sys.executable,
            str(root / "qa/offline.py"),
            "--url",
            url,
            "--immediate",
            "--output",
            str(root / "evidence" / RECEIPTS[case]),
        ]
    if case in ("device_sync", "chat"):
        address = ["--bun", bun]
    elif case in KEYWORD_URL:
        address = ["--url", url]
    elif case == "reference_ui":
        address = ["--url", url]
        if os.environ.get("FOLIO_REFERENCE_IMAGE"):
            address.extend(["--reference-image", os.environ["FOLIO_REFERENCE_IMAGE"]])
    else:
        address = [url]
    return [sys.executable, str(root / "qa" / (case + ".py")), *address]


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, epilog="Scenarios: " + ", ".join(RECEIPTS)
    )
    parser.add_argument("case", nargs="*", metavar="SCENARIO", help="Defaults to every case")
    parser.add_argument("--report", type=Path, help="Override the JSON report path.")
    args = parser.parse_args()
    unknown = set(args.case) - RECEIPTS.keys()
    if unknown:
        parser.error("Unknown scenario: " + ", ".join(sorted(unknown)))
    cases = list(dict.fromkeys(args.case)) if args.case else list(RECEIPTS)
    root = Path(__file__).resolve().parents[1]
    evidence = root / "evidence"
    evidence.mkdir(exist_ok=True)
    full = set(cases) == RECEIPTS.keys()
    receipt = args.report or evidence / ("acceptance.json" if full else "acceptance-subset.json")
    bun = os.environ.get("BUN_PATH") or shutil.which("bun")
    if not bun:
        raise SystemExit("Install Bun or set BUN_PATH to its executable.")
    env = dict(
        os.environ,
        PATH=str(Path(bun).absolute().parent) + os.pathsep + os.environ["PATH"],
        PYTHONDONTWRITEBYTECODE="1",
    )
    start = time.monotonic()
    started_at = datetime.now(timezone.utc).isoformat()
    input_digest = source_hash(root)
    subprocess.run([bun, "run", "build"], cwd=root, env=env, check=True)
    built = hash_tree(root / "dist", (root / "dist").rglob("*"))
    with tempfile.TemporaryDirectory(prefix="folio-acceptance-") as temp:
        service_env = dict(
            env, HOST="127.0.0.1", PORT="0", FOLIO_DB=str(Path(temp) / "board.sqlite")
        )
        with subprocess.Popen(
            [bun, "server/index.ts"], cwd=root, env=service_env, text=True, stdout=subprocess.PIPE
        ) as service:
            try:
                url = (
                    service.stdout.readline()
                    .strip()
                    .removeprefix("Folio listening at ")
                    .rstrip("/")
                )
                if not url.startswith("http://127.0.0.1:"):
                    raise RuntimeError("The local server did not supply a listening URL")

                def scenario(case):
                    began = time.monotonic()
                    report = evidence / RECEIPTS[case]
                    previous = report.stat().st_mtime_ns if report.exists() else None
                    argv = scenario_command(root, case, url, bun)
                    code = subprocess.run(argv, env=env, cwd=root).returncode
                    fresh = report.is_file() and report.stat().st_mtime_ns != previous
                    result = {
                        "scenario": case,
                        "exitCode": code,
                        "regeneratedEvidence": fresh,
                        "passed": code == 0 and fresh,
                        "seconds": round(time.monotonic() - began, 2),
                    }
                    if fresh:
                        result.update(
                            evidence=report.name,
                            evidenceSha256=hashlib.sha256(report.read_bytes()).hexdigest(),
                        )
                    return result

                with ThreadPoolExecutor(max_workers=min(len(cases), 3)) as pool:
                    checks = list(pool.map(scenario, cases))
                stable = input_digest == source_hash(root) and built == hash_tree(
                    root / "dist", (root / "dist").rglob("*")
                )
                passed = sum(check["passed"] for check in checks)
                report = {
                    "startedUtc": started_at,
                    "completedUtc": datetime.now(timezone.utc).isoformat(),
                    "elapsedSeconds": round(time.monotonic() - start, 2),
                    "productionBuildSha256": built,
                    "appSourceSha256": input_digest,
                    "sourceAndBuildUnchanged": stable,
                    "runtime": "Bun "
                    + subprocess.check_output([bun, "--version"], text=True).strip(),
                    "selected": len(checks),
                    "passed": passed,
                    "failed": len(checks) - passed,
                    "fullSuite": full,
                    "checks": checks,
                }
                receipt.parent.mkdir(parents=True, exist_ok=True)
                receipt.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
                print(
                    "Headless scenarios:", passed, "/", len(checks), "report:", receipt, flush=True
                )
                if passed != len(checks) or (full and not stable):
                    raise SystemExit(1)
            finally:
                service.terminate()
                try:
                    service.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    service.kill()


if __name__ == "__main__":
    main()
