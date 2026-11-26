"""Exercise six authenticated writers and two readers against a persisted mixed board."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time

from perf_fixture import Device, compact, record, seed
from server_scale import Browser, ROOT, encode, get_memory, latency, server

RECORDS = 50_000
EDITORS = 6
VIEWERS = 2
WRITES = 120
PHASES = 12
SPACING = 96
COLUMNS = math.ceil(math.sqrt(RECORDS))


@dataclass
class Fixture:
    path: str
    rev: int
    digest: str
    editors: list
    viewers: list


def prepare(bun, root, temp):
    with server(bun, root, temp / "seed.sqlite") as (url, _):
        owner = Device(url.rstrip("/"))
        path, rev, digest = seed(owner, RECORDS, SPACING)

        def devices(role, count):
            token = owner.api(path + "/share", {"role": role})["token"]
            cookies = []
            for _ in range(count):
                device = Browser(url)
                joined = json.loads(device.send("/api/join", {"token": token}))
                assert joined["role"] == role
                cookies.append(device.cookies)
            return cookies

        editors = devices("editor", EDITORS)
        viewers = devices("viewer", VIEWERS)
        assert len({c["folio_session"] for c in editors + viewers}) == EDITORS + VIEWERS
        subprocess.run(
            [
                bun,
                "service/backup.js",
                "backup",
                str(temp / "seed.sqlite"),
                str(temp / "backup.sqlite"),
            ],
            cwd=root,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return Fixture(path, rev, digest, editors, viewers)


def operations(fixture):
    plan = []
    for writer in range(EDITORS):
        work = []
        for step in range(WRITES):
            # A coprime stride distributes the edits over the board with no collisions.
            index = (step * EDITORS + writer) * 73 % RECORDS
            shape = record(index, COLUMNS, SPACING)
            shape["x"] += writer + 1
            shape["props"]["label"] = f"editor {writer} edit {step}"
            # Every writer starts from the same revision. Distinct IDs may safely merge.
            raw = encode(
                {
                    "opId": f"edit-{writer}-{step}",
                    "baseRev": fixture.rev,
                    "put": {shape["id"]: shape},
                }
            )
            work.append((shape, raw))
        plan.append(work)
    return plan


def decode(body):
    return json.loads(gzip.decompress(body) if body.startswith(b"\x1f\x8b") else body)


def revision(body):
    # Parse the small metadata prefix without spending reader time decoding 50k shapes.
    if body.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(body)) as source:
            prefix = source.read(1024)
    else:
        prefix = body[:1024]
    return int(re.search(rb'"rev"\s*:\s*([0-9]+)', prefix)[1])


def stats(samples):
    ordered = sorted(samples)

    def percentile(p):
        return round(ordered[max(0, math.ceil(len(ordered) * p) - 1)], 3)

    return {
        "count": len(samples),
        "p50Ms": percentile(0.5),
        "p95Ms": percentile(0.95),
        "maxMs": round(max(samples), 3),
    }


def run_load(url, pid, fixture, plan):
    barrier = threading.Barrier(EDITORS + VIEWERS, timeout=45)

    def writer(w):
        device = Browser(url, fixture.editors[w])
        elapsed = []
        stamps = []
        for step, (shape, raw) in enumerate(plan[w]):
            if step % (WRITES // PHASES) == 0:
                barrier.wait()
            ms, body = latency(lambda: device.send(fixture.path + "/ops", raw))
            ack = json.loads(body)
            assert ack["duplicate"] is False
            elapsed.append(ms)
            stamps.append((ack["rev"], shape))
        return elapsed, stamps

    def viewer(v):
        device = Browser(url, fixture.viewers[v])
        seen = fixture.rev
        frames = []
        for phase in range(PHASES):
            barrier.wait()
            # Both readers issue a cold full GET at startup. Their later read windows
            # exercise revision-based catch-up while the six writers continue committing.
            full = phase == 0
            path = (
                fixture.path if full else fixture.path + "/changes?since=" + str(seen)
            )
            ms, body = latency(lambda: device.send(path, accept_encoding="gzip"))
            end = revision(body)
            assert end >= seen
            frames.append((full, seen, end, ms, body))
            seen = end
        return frames

    def guarded(function, index):
        try:
            return function(index)
        except BaseException:
            barrier.abort()
            raise

    began = time.perf_counter()
    with ThreadPoolExecutor(max_workers=EDITORS + VIEWERS) as pool:
        writers = [pool.submit(guarded, writer, i) for i in range(EDITORS)]
        readers = [pool.submit(guarded, viewer, i) for i in range(VIEWERS)]
        commits = [future.result() for future in writers]
        observations = [future.result() for future in readers]
    wall = time.perf_counter() - began
    stamps = dict(item for _, edits in commits for item in edits)
    end = fixture.rev + EDITORS * WRITES
    assert set(stamps) == set(range(fixture.rev + 1, end + 1))
    changes = {obj["id"]: obj for obj in stamps.values()}
    assert len(changes) == EDITORS * WRITES
    for frames in observations:
        for full, start, until, _, body in frames:
            doc = decode(body)
            assert doc["role"] == "viewer" and doc["rev"] == until
            expected = {
                obj["id"]: obj for rev, obj in stamps.items() if start < rev <= until
            }
            if full:
                assert len(doc["items"]) == RECORDS
                observed = {
                    k: o for k, o in doc["items"].items() if "label" in o["props"]
                }
                assert observed == expected
            else:
                assert not doc["remove"] and doc["put"] == expected
    writes = [ms for times, _ in commits for ms in times]
    detail = [
        [
            {
                "kind": "snapshot" if full else "delta",
                "from": start,
                "through": end,
                "wireBytes": len(body),
                "ms": round(ms, 3),
            }
            for full, start, end, ms, body in frames
        ]
        for frames in observations
    ]
    return {
        "write": stats(writes),
        "coldRead": stats(
            [ms for frames in observations for full, _, _, ms, _ in frames if full]
        ),
        "deltaRead": stats(
            [ms for frames in observations for full, _, _, ms, _ in frames if not full]
        ),
        "wallSeconds": round(wall, 3),
        "writesPerSecond": round(len(writes) / wall, 2),
        "serverPeakRssMiB": get_memory(pid, "VmHWM"),
        "revisionBefore": fixture.rev,
        "revisionAfter": end,
        "readerSnapshotsConsistentAtEveryRevision": True,
        "writerSamplesMs": [[round(ms, 3) for ms in times] for times, _ in commits],
        "readerSamples": detail,
    }, changes


def after_restart(url, fixture, changes, expected_rev):
    device = Browser(url, fixture.viewers[0])
    snapshot = decode(device.send(fixture.path, accept_encoding="gzip"))
    assert snapshot["rev"] == expected_rev and len(snapshot["items"]) == RECORDS
    digest = hashlib.sha256()
    for index in range(RECORDS):
        original = record(index, COLUMNS, SPACING)
        key = original["id"]
        actual = snapshot["items"][key]
        assert actual == changes.get(key, original), key
        digest.update(compact(actual) + b"\n")
    delta = decode(
        device.send(
            fixture.path + "/changes?since=" + str(fixture.rev), accept_encoding="gzip"
        )
    )
    assert (
        not delta["remove"] and delta["put"] == changes and delta["rev"] == expected_rev
    )
    return digest.hexdigest()


def measure(bun, root, temp, label, fixture, plan):
    db = temp / (label + ".sqlite")
    subprocess.run(
        [bun, "service/backup.js", "restore", str(temp / "backup.sqlite"), str(db)],
        cwd=root,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    with server(bun, root, db) as (url, pid):
        report, changes = run_load(url, pid, fixture, plan)
    with server(bun, root, db) as (url, _):
        report["restartVerifiedDocumentSha256"] = after_restart(
            url, fixture, changes, report["revisionAfter"]
        )
    report["acknowledgedWritesVerifiedAfterRestart"] = len(changes)
    return report


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--baseline", type=Path)
    ap.add_argument("--bun", default=os.environ.get("BUN_PATH") or shutil.which("bun"))
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="folio-multiwriter-") as folder:
        temp = Path(folder)
        fixture = prepare(args.bun, (args.baseline or args.root).resolve(), temp)
        plan = operations(fixture)
        result = {
            "records": RECORDS,
            "writers": EDITORS,
            "viewers": VIEWERS,
            "writesPerEditor": WRITES,
            "initialSha256": fixture.digest,
            "percentileMethod": "nearest rank",
        }
        if args.baseline:
            result["before"] = measure(
                args.bun, args.baseline.resolve(), temp, "before", fixture, plan
            )
        result["after"] = measure(
            args.bun, args.root.resolve(), temp, "after", fixture, plan
        )
        if args.baseline:
            assert (
                result["before"]["restartVerifiedDocumentSha256"]
                == result["after"]["restartVerifiedDocumentSha256"]
            )
    output = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.write_text(output)
    print(output)


if __name__ == "__main__":
    main()
