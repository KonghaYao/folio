"""Compare two packaged Folio builds in counterbalanced, strictly sequential fresh browsers."""

import argparse
import json
import os
from pathlib import Path
import platform
import signal
import statistics
import subprocess
import sys
import time

from perf_board import atomic

HERE = Path(__file__).resolve().parent
METRICS = {
    "coldOpenMs": ("openReadyPaintMs",),
    "firstVerifiedVisibleMs": ("firstVerifiedVisibleMs",),
    "overviewPanP95Ms": ("overviewPan", "p95Ms"),
    "overviewMissedPct": ("overviewPan", "missedFramePct"),
    "localPanP95Ms": ("pan", "p95Ms"),
    "localZoomP95Ms": ("zoom", "p95Ms"),
    "penFirstPaintBoundMs": ("penMoveToPaintBoundMs",),
    "durableAckMs": ("serverAckMsFromPenDown",),
    "peerVisibleMs": ("peerVisibleMsFromPenDown",),
    "reloadMs": ("reloadReadyPaintMs",),
}


def summarize(results):
    summary = []
    for n, label in sorted({(d["objects"], d["label"]) for d in results}):
        group = [d for d in results if d["objects"] == n and d["label"] == label]
        good = [d for d in group if d["passed"]]
        row = {
            "objects": n,
            "label": label,
            "attempted": len(group),
            "passed": len(good),
            "metrics": {},
        }
        for metric, path in METRICS.items():
            values = []
            for d in good:
                v = d
                for key in path:
                    v = v[key]
                values.append(v)
            if values:
                row["metrics"][metric] = {
                    "perRun": values,
                    "medianAcrossRuns": round(statistics.median(values), 2),
                }
        summary.append(row)
    return summary


def process_tree(root_pid):
    """Include detached Chromium process groups. Shared mapped pages may be counted repeatedly."""
    proc = Path("/proc")
    if not proc.is_dir():
        return [], None
    children = {}
    for status in proc.glob("[0-9]*/stat"):
        try:
            # comm may contain whitespace or parentheses. The PPID follows state.
            fields = status.read_text().rsplit(")", 1)[1].split()
            children.setdefault(int(fields[1]), []).append(int(status.parent.name))
        except (OSError, IndexError, ValueError):
            continue
    selected = [root_pid]
    for pid in selected:
        selected.extend(children.get(pid, ()))
    pages = 0
    for pid in selected:
        try:
            pages += int((proc / str(pid) / "statm").read_text().split()[1])
        except (OSError, IndexError, ValueError):
            continue
    return selected, round(pages * os.sysconf("SC_PAGE_SIZE") / 1048576, 1)


def run_case(plan, args, folder):
    label, root, n, rep = plan
    raw = folder / f"{label}-{n}-run{rep}.json"
    log = raw.with_suffix(".log")
    command = [
        sys.executable,
        str(HERE / "perf_board.py"),
        "--app",
        str(root),
        "--count",
        str(n),
        "--out",
        str(raw),
        "--label",
        label,
        "--run",
        str(rep),
        "--spacing",
        str(args.spacing),
    ]
    print(f"{label} {n:,} repetition {rep}", flush=True)
    start = time.monotonic()
    killed = None
    peak = 0
    with log.open("w") as sink, subprocess.Popen(
        command, stdout=sink, stderr=subprocess.STDOUT, start_new_session=True
    ) as child:
        while child.poll() is None:
            descendants, rss = process_tree(child.pid)
            if rss:
                peak = max(peak, rss)
            if time.monotonic() - start > args.timeout:
                killed = "case_time_limit"
            elif rss and rss > args.max_rss_mib:
                killed = "process_tree_rss_limit"
            if killed:
                for pid in reversed(descendants):
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                break
            time.sleep(0.5)
    result = (
        json.loads(raw.read_text())
        if raw.is_file()
        else {"label": label, "objects": n, "run": rep, "phase": "startup"}
    )
    result["exitCode"] = child.returncode
    result["elapsedSeconds"] = round(time.monotonic() - start, 2)
    result["peakProcessTreeRssMiB"] = peak or None
    if killed or child.returncode:
        result["passed"] = False
        if killed:
            result["error"] = killed
    atomic(raw, result)
    print("  ", result["phase"], result["elapsedSeconds"], "s", result.get("error", ""), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--optimized", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--counts", nargs="+", type=int, default=[1000, 10000, 50000, 100000])
    parser.add_argument("--small-runs", type=int, default=1)
    parser.add_argument("--large-runs", type=int, default=2)
    parser.add_argument("--spacing", type=int, default=90)
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--max-rss-mib", type=float, default=3500)
    args = parser.parse_args()
    args.out.mkdir(exist_ok=True, parents=True)
    if any(args.out.glob("*.json")):
        parser.error("Supply a fresh output directory to preserve earlier measurements")
    for n in args.counts:
        if n < 2 or n > 100000:
            parser.error("Choose between 2 and 100000 objects")
    plan = []
    for n in args.counts:
        builds = [("baseline", args.baseline.resolve())]
        if args.optimized:
            builds.append(("optimized", args.optimized.resolve()))
        for i in range(1, (args.large_runs if n >= 50000 else args.small_runs) + 1):
            ordered = builds if i % 2 else list(reversed(builds))
            plan.extend((name, root, n, i) for name, root in ordered)
    results = []
    for item in plan:
        results.append(run_case(item, args, args.out))
        summary = {
            "platform": platform.platform(),
            "viewport": [1280, 800],
            "spacing": args.spacing,
            "timeoutSeconds": args.timeout,
            "maxRssMiB": args.max_rss_mib,
            "sequence": [{"label": p[0], "objects": p[2], "run": p[3]} for p in plan],
            "completed": len(results),
            "summary": summarize(results),
        }
        atomic(args.out / "matrix.json", summary)
    return int(not all(d["passed"] for d in results))


if __name__ == "__main__":
    raise SystemExit(main())
