"""Measure production HTTP, using a restored 50,000+ record board and two real sessions."""

import argparse
import concurrent.futures
from contextlib import contextmanager
import hashlib
import gzip
import http.client
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

MIB = 1024 * 1024
N = 50_000
BATCH = 2048
ROOT = Path(__file__).resolve().parents[1]


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class Browser:
    def __init__(self, url, cookies=None):
        self.host = urlsplit(url).netloc
        self.cookies = dict(cookies or {})

    def send(self, path, value=None, status=200, accept_encoding="identity"):
        connection = http.client.HTTPConnection(self.host, timeout=45)
        payload = (
            value
            if isinstance(value, bytes)
            else (encode(value) if value is not None else None)
        )
        try:
            connection.request(
                "POST" if payload is not None else "GET",
                path,
                payload,
                {
                    "Cookie": "; ".join(self.cookies.values()),
                    "Content-Type": "application/json",
                    "Accept-Encoding": accept_encoding,
                },
            )
            response = connection.getresponse()
            for k, v in response.getheaders():
                if k.lower() == "set-cookie":
                    pair = v.split(";")[0]
                    self.cookies[pair.split("=")[0]] = pair
            body = response.read()
            assert response.status == status, (path, response.status, body[:250])
            return body
        finally:
            connection.close()


@contextmanager
def server(bun, root, db):
    process = subprocess.Popen(
        [bun, "service/index.js"],
        cwd=root,
        env={
            **os.environ,
            "FOLIO_DB": str(db),
            "HOST": "127.0.0.1",
            "PORT": "0",
        },
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        url = process.stdout.readline().strip().split(" at ")[-1]
        assert url.startswith("http"), "Service failed to start"
        yield url, process.pid
    finally:
        process.terminate()
        process.wait(timeout=10)


def shape(i):
    key = f"shape:scale-{i:06d}"
    return key, {
        "id": key,
        "typeName": "shape",
        "type": "note",
        "x": (i % 500) * 160,
        "y": (i // 500) * 140,
        "z": i,
        "rot": 0,
        "props": {
            "text": f'编号 {i:06d} "sample"\n' + ("Measured board record. " * 12),
            "color": "yellow",
            "size": "m",
            "font": "sans",
        },
    }


def prepare(bun, root, temp):
    db = temp / "source.sqlite"
    with server(bun, root, db) as (url, _):
        owner = Browser(url)
        board = json.loads(
            owner.send("/api/boards", {"title": 'Load "test" 🪶\nboard'}, 201)
        )
        path = "/api/boards/" + board["id"]
        grant = json.loads(owner.send(path + "/share", {"role": "viewer"}, 201))
        viewer = Browser(url)
        viewer.send("/api/join", {"token": grant["token"]})
        rev = 0
        bodies = 0
        for start in range(0, N, BATCH):
            put = dict(shape(i) for i in range(start, min(start + BATCH, N)))
            op = {"opId": f"chunk-{start}", "baseRev": rev, "put": put, "remove": []}
            rev = json.loads(owner.send(path + "/ops", op))["rev"]
            bodies += sum(len(encode(v)) for v in put.values())
        # Same record count, with a revision that contains both an update and tombstone.
        before_last = rev
        key, note = shape(N)
        deleted, previous = shape(N - 1)
        bodies += len(encode(note)) - len(encode(previous))
        final = {
            "opId": "tail",
            "baseRev": rev,
            "put": {key: note},
            "remove": [deleted],
        }
        rev = json.loads(owner.send(path + "/ops", final))["rev"]
        assert json.loads(owner.send(path + "/ops", final))["duplicate"]
        subprocess.run(
            [
                bun,
                "service/backup.js",
                "backup",
                str(db),
                str(temp / "baseline.sqlite"),
            ],
            cwd=root,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        return path, viewer.cookies, owner.cookies, rev, before_last, bodies


def latency(fn):
    start = time.perf_counter_ns()
    result = fn()
    return (time.perf_counter_ns() - start) / 1e6, result


def get_memory(pid, field):
    status = Path("/proc") / str(pid) / "status"
    if not status.exists():
        return None
    for line in status.read_text().splitlines():
        if line.startswith(field + ":"):
            return round(int(line.split()[1]) / 1024, 1)
    return None


def timings(browser, path, runs):
    samples = [latency(lambda: browser.send(path))[0] for _ in range(runs)]
    return {
        "medianMs": round(statistics.median(samples), 2),
        "samplesMs": [round(s, 2) for s in samples],
    }


def probe_limits(owner, path, rev, bodies):
    op_path = path + "/ops"
    key, note = shape(0)
    # Whitespace is legal JSON and isolates request byte limits from record content.
    body = encode({"opId": "exact-op-limit", "baseRev": rev, "put": {key: note}})
    padded = body + b" " * (4 * MIB - len(body))
    rev = json.loads(owner.send(op_path, padded))["rev"]
    assert (
        json.loads(owner.send(op_path, padded + b" ", 413))["error"]
        == "request_too_large"
    )
    keys = [f"missing:{i}" for i in range(4097)]
    rev = json.loads(
        owner.send(op_path, {"opId": "max-count", "baseRev": rev, "remove": keys[:-1]})
    )["rev"]
    assert (
        json.loads(
            owner.send(
                op_path, {"opId": "over-count", "baseRev": rev, "remove": keys}, 400
            )
        )["error"]
        == "invalid_changes"
    )
    # Fill the board in individually bounded mutations, including exact UTF-8 byte boundary.
    add = 0
    while bodies < 32 * MIB:
        key, note = shape(N + 1 + add)
        note["props"]["text"] = ""
        gap = 32 * MIB - bodies
        record_bytes = min(2 * MIB, gap)
        assert record_bytes >= len(encode(note))
        note["props"]["text"] = "x" * (record_bytes - len(encode(note)))
        op = {"opId": f"fill-{add}", "baseRev": rev, "put": {key: note}}
        rev = json.loads(owner.send(op_path, op))["rev"]
        bodies += record_bytes
        add += 1
    note["props"]["text"] += "x"
    assert (
        json.loads(
            owner.send(
                op_path, {"opId": "over-board", "baseRev": rev, "put": {key: note}}, 413
            )
        )["error"]
        == "board_size_limit"
    )
    unchanged = json.loads(owner.send(path + "/changes?since=" + str(rev)))
    assert unchanged["rev"] == rev and not unchanged["put"] and not unchanged["remove"]
    return {
        "acceptedBodyBytes": bodies,
        "firstRejectedBodyBytes": bodies + 1,
        "recordCountAtByteLimit": N + add,
        "acceptedOpBytes": len(padded),
        "acceptedOpCount": 4096,
        "atomicRollback": True,
    }


def measure(bun, root, temp, state, runs, check_limits):
    path, viewer_cookies, owner_cookies, rev, before_last, bodies = state
    db = temp / (root.name + "-" + str(time.time_ns()) + ".sqlite")
    subprocess.run(
        [bun, "service/backup.js", "restore", str(temp / "baseline.sqlite"), str(db)],
        cwd=root,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    with server(bun, root, db) as (url, pid):
        viewer = Browser(url, viewer_cookies)
        initial_rss = get_memory(pid, "VmRSS")

        def cold_open(_):
            elapsed, body = latency(lambda: Browser(url, viewer_cookies).send(path))
            return elapsed, len(body), hashlib.sha256(body).hexdigest()

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as threads:
            cold = list(threads.map(cold_open, range(2)))
        assert cold[0][1:] == cold[1][1:]
        cold_hwm = get_memory(pid, "VmHWM")
        snap = timings(viewer, path, runs)
        catchup = timings(viewer, path + "/changes?since=0", runs)
        small = timings(viewer, path + "/changes?since=" + str(before_last), runs)
        body = json.loads(viewer.send(path))
        assert (
            len(body["items"]) == N and body["role"] == "viewer" and body["rev"] == rev
        )
        assert (
            body["items"][shape(99)[0]] == shape(99)[1]
            and shape(N - 1)[0] not in body["items"]
        )
        delta = json.loads(viewer.send(path + "/changes?since=0"))
        assert delta["put"] == body["items"] and delta["remove"] == [shape(N - 1)[0]]
        one = json.loads(viewer.send(path + "/changes?since=" + str(before_last)))
        assert one["put"] == dict([shape(N)]) and one["remove"] == delta["remove"]
        del body, delta
        result = {
            "records": N,
            "itemBodyBytes": bodies,
            "snapshotWireBytes": cold[0][1],
            "restoredFromLiveBackup": True,
            "coldTwoReadersMs": [round(i[0], 2) for i in cold],
            "idleRssMiB": initial_rss,
            "coldPeakRssMiB": cold_hwm,
            "snapshot": snap,
            "fullDelta": catchup,
            "twoRecordDelta": small,
        }
        negotiated = viewer.send(path, accept_encoding="gzip")
        compressed = negotiated.startswith(b"\x1f\x8b")
        plain = gzip.decompress(negotiated) if compressed else negotiated
        assert hashlib.sha256(plain).hexdigest() == cold[0][2]
        result["negotiatedSnapshot"] = {
            "encoding": "gzip" if compressed else "identity",
            "wireBytes": len(negotiated),
            "uncompressedBytes": len(plain),
        }
        del negotiated, plain
        owner = Browser(url, owner_cookies)
        times = []
        for i in range(runs):
            # Overwrite existing records at an unchanged size, preserving the boundary fixture.
            first = i * 1024
            put = dict(shape(j) for j in range(first, first + 1024))
            elapsed, ack = latency(
                lambda: owner.send(
                    path + "/ops", {"opId": f"write-{i}", "baseRev": rev, "put": put}
                )
            )
            rev = json.loads(ack)["rev"]
            times.append(elapsed)
        result["update1024"] = {
            "medianMs": round(statistics.median(times), 2),
            "samplesMs": [round(s, 2) for s in times],
        }
        if check_limits:
            result["boundary"] = probe_limits(
                Browser(url, owner_cookies), path, rev, bodies
            )
        return result


def compact_capacity(bun, root, temp):
    """Admit successive actual shapes until one more crosses the existing byte quota."""
    db = temp / "compact.sqlite"
    with server(bun, root, db) as (url, _):
        owner = Browser(url)
        bid = json.loads(owner.send("/api/boards", {"title": "Compact geometry"}, 201))[
            "id"
        ]
        path = "/api/boards/" + bid
        token = json.loads(owner.send(path + "/share", {"role": "viewer"}, 201))[
            "token"
        ]
        viewer = Browser(url)
        viewer.send("/api/join", {"token": token})
        count = total = rev = 0
        while True:
            put = {}
            for _ in range(BATCH):
                key = f"shape:{count:06d}"
                record = {
                    "id": key,
                    "typeName": "shape",
                    "type": "geo",
                    "x": (count % 600) * 42,
                    "y": (count // 600) * 42,
                    "z": count,
                    "rot": 0,
                    "props": {"w": 32, "h": 32},
                }
                size = len(encode(record))
                if total + size > 32 * MIB:
                    break
                put[key] = record
                count += 1
                total += size
            if put:
                rev = json.loads(
                    owner.send(
                        path + "/ops",
                        {"opId": f"compact-{rev}", "baseRev": rev, "put": put},
                    )
                )["rev"]
            if len(put) < BATCH:
                failure = json.loads(
                    owner.send(
                        path + "/ops",
                        {"opId": "over-compact", "baseRev": rev, "put": {key: record}},
                        413,
                    )
                )
                assert failure["error"] == "board_size_limit"
                break
    with server(bun, root, db) as (url, pid):
        viewer = Browser(url, viewer.cookies)
        elapsed, raw = latency(lambda: viewer.send(path, accept_encoding="gzip"))
        plain = gzip.decompress(raw) if raw.startswith(b"\x1f\x8b") else raw
        snapshot = json.loads(plain)
        assert (
            len(snapshot["items"]) == count
            and snapshot["rev"] == rev
            and key not in snapshot["items"]
        )
        return {
            "records": count,
            "nextRecordRejected": True,
            "itemBodyBytes": total,
            "nextRecordBodyBytes": size,
            "coldViewerLoadMs": round(elapsed, 2),
            "coldServerPeakRssMiB": get_memory(pid, "VmHWM"),
            "wireBytes": len(raw),
            "uncompressedBytes": len(plain),
            "reloadVerified": True,
        }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bun", default=os.environ.get("BUN_PATH") or shutil.which("bun"))
    ap.add_argument(
        "--baseline",
        type=Path,
        help="Optional frozen production build for paired measurements",
    )
    ap.add_argument("--root", type=Path, default=ROOT)
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--output", type=Path)
    ap.add_argument(
        "--compact-boundary",
        action="store_true",
        help="Also fill a board with compact rectangles up to its 32 MiB cap",
    )
    args = ap.parse_args()
    with tempfile.TemporaryDirectory(prefix="folio-http-scale-") as tmp:
        temp = Path(tmp)
        args.root = args.root.resolve()
        state = prepare(args.bun, args.baseline or args.root, temp)
        result = {}
        if args.baseline:
            result["before"] = measure(
                args.bun, args.baseline.resolve(), temp, state, args.runs, False
            )
        result["after"] = measure(args.bun, args.root, temp, state, args.runs, True)
        if args.compact_boundary:
            result["compactBoundary"] = compact_capacity(args.bun, args.root, temp)
    report = json.dumps(result, indent=2) + "\n"
    if args.output:
        args.output.write_text(report)
    print(report)


if __name__ == "__main__":
    main()
