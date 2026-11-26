"""Deterministic mixed whiteboard data and authenticated fixture client for browser scale tests."""

from contextlib import contextmanager
import hashlib
from http.cookiejar import CookieJar
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from urllib.request import build_opener, HTTPCookieProcessor, Request

COLORS = ("#217472", "#dc6744", "#3d63b7", "#d09b35")
POINTS = [
    [0, 12, 0.25, -28, 12, 30, 0],
    [6, 4, 0.5, -12, 5, 48, 0],
    [15, 8, 0.8, 8, -5, 90, 0],
    [27, 2, 0.65, 16, -14, 125, 0],
    [36, 7, 0.4, 20, -18, 160, 0],
]


def compact(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def record(index, columns, spacing):
    id_ = f"shape:perf{index:06d}"
    color = COLORS[(index * 13 + index // columns) % len(COLORS)]
    x = (index % columns) * spacing + (index * 7) % 9
    y = (index // columns) * spacing + (index * 11) % 7
    kind = "geo"
    if index % 10 == 0:
        kind = "draw"
        props = dict(
            pts=[v for pt in POINTS for v in pt[:3]],
            color=color,
            size="m",
            done=True,
            isPen=True,
            dash="solid",
            ink=dict(version=1, brush="pen", color=color, width=4, samples=POINTS),
        )
    elif index % 20 == 1:
        kind = "note"
        props = dict(
            color=color, size="s", text="N" + str(index), font="sans", scale=1, autosize=True
        )
    else:
        props = dict(
            geo="rectangle" if index % 3 else "ellipse",
            w=34,
            h=24,
            color=color,
            size="s",
            dash="solid",
            fill="solid",
        )
    return dict(id=id_, typeName="shape", type=kind, x=x, y=y, z=index + 1, rot=0, props=props)


class Device:
    def __init__(self, origin):
        self.origin = origin
        self.jar = CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.jar))

    def api(self, path, body=None):
        data = compact(body) if body is not None else None
        with self.opener.open(
            Request(self.origin + path, data=data, headers={"Content-Type": "application/json"}),
            timeout=90,
        ) as resp:
            return json.load(resp)

    def cookies(self):
        return [{"name": c.name, "value": c.value, "url": self.origin} for c in self.jar]


def seed(owner, count, spacing):
    board = owner.api("/api/boards", {"title": f"压力测试 {count}"})
    prefix = "/api/boards/" + board["id"]
    revision = board["rev"]
    columns = math.ceil(math.sqrt(count))
    digest = hashlib.sha256()
    for start in range(0, count, 2000):
        put = {}
        for i in range(start, min(start + 2000, count)):
            obj = record(i, columns, spacing)
            digest.update(compact(obj) + b"\n")
            put[obj["id"]] = obj
        revision = owner.api(
            prefix + "/ops", dict(opId=f"seed-{start}", baseRev=revision, put=put, remove=[])
        )["rev"]
    return prefix, revision, digest.hexdigest()


@contextmanager
def service(root):
    bun = os.environ.get("BUN_PATH") or shutil.which("bun")
    if not bun:
        raise RuntimeError("Install Bun or set BUN_PATH")
    with tempfile.TemporaryDirectory(prefix="folio-perf-db-") as temp:
        db = Path(temp) / "board.sqlite"
        env = dict(
            os.environ, HOST="127.0.0.1", PORT="0", FOLIO_DB=str(db), STATIC_DIR=str(root / "dist")
        )
        with subprocess.Popen(
            [bun, "service/index.js"], cwd=root, env=env, stdout=subprocess.PIPE, text=True
        ) as proc:
            try:
                url = proc.stdout.readline().strip().removeprefix("Folio listening at ").rstrip("/")
                if not url.startswith("http://127.0.0.1:"):
                    raise RuntimeError("The packaged Folio service did not start")
                yield url
            finally:
                proc.kill()
                proc.wait()
