"""Original pen choreography, in a 700 by 460 logical drawing area.

Coordinates describe hand gestures, never serialized board objects. Closed color areas
are painted using a continuous back-and-forth pen stroke inside the outline.
"""

from dataclasses import dataclass
from math import ceil, cos, pi, sin
from svgpathtools import parse_path

INK = "#263e36"
SOFT = "#739087"
BONE = "#f6ebcf"
PAPER = "#fffaec"
SHADE = "#d4dcc4"
GOLD = "#f2b958"
ORANGE = "#dd8050"
TEAL = "#43877b"
RED = "#bc6752"


@dataclass
class Stroke:
    color: str
    width: float
    points: list
    tilt: int = 5


def path_points(path, spacing=4):
    points = []
    for segment in (parse_path(path) if isinstance(path, str) else path):
        steps = max(1, ceil(segment.length() / spacing))
        pts = [segment.point(i / steps) for i in range(steps + 1)]
        points.extend([(p.real, p.imag) for p in (pts[1:] if points else pts)])
    return points


def artwork():
    strokes = []

    def line(d, w=2.5, c=INK, tilt=8):
        for subpath in parse_path(d).continuous_subpaths():
            strokes.append(Stroke(c, w, path_points(subpath, 4.4), tilt))

    def paint(d, fill, width=2.8, outline=INK, brush=7):
        pts = path_points(d, 2.4)
        edges = list(zip(pts, pts[1:] + pts[:1]))
        ymin = min(y for _, y in pts)
        ymax = max(y for _, y in pts)
        prev = None
        tracks = []
        y = ymin + 1.6
        forward = True
        while y < ymax - 1:
            xs = sorted(
                x1 + (y - y1) * (x2 - x1) / (y2 - y1)
                for (x1, y1), (x2, y2) in edges
                if (y1 <= y < y2 or y2 <= y < y1)
            )
            intervals = [
                (xs[j] + 1.6, xs[j + 1] - 1.6)
                for j in range(0, len(xs) - 1, 2)
                if xs[j + 1] - xs[j] > 3.2
            ]
            if len(intervals) == 1:
                a, b = intervals[0]
                if not forward:
                    a, b = b, a
                if prev is not None and abs(prev - a) > brush * 2.2:
                    prev = None
                if prev is None:
                    tracks.append([])
                tracks[-1].extend([(a, y), (b, y)])
                prev = b
                forward = not forward
            else:
                prev = None
                for a, b in intervals:
                    tracks.append([(a, y), (b, y)])
            y += brush * 0.43
        for track in tracks:
            if track:
                strokes.append(Stroke(fill, brush, track, 0))
        if width:
            line(d, width, outline)
        else:
            # A finishing stroke follows the edge of the colored plumage or bill.
            line(d, brush * 0.76, fill, 0)

    def circle(x, y, r, w=2, c=INK):
        points = [(x + cos(2 * pi * t / 96) * r, y + sin(2 * pi * t / 96) * r) for t in range(97)]
        strokes.append(Stroke(c, w, points))

    def solid(x, y, r, c):
        circle(x, y, r * 0.46, max(2, r * 1.35), c)

    # A few coastal marks keep the wheels grounded.
    line("M106 439 Q200 436 291 439", 2, SOFT)
    line("M370 439 Q497 436 603 439", 2, SOFT)
    line("M116 445 L152 445 M163 445 L177 445", 1.2, SOFT)
    line("M582 445 L611 445", 1.2, SOFT)
    for x, y, s in [(100, 183, 1), (142, 153, 0.64), (588, 194, 0.6)]:
        line(
            f"M{x-12*s} {y-3*s} Q{x-4*s} {y-5*s} {x} {y+3*s} Q{x+4*s} {y-6*s} {x+12*s} {y-7*s}",
            1.8,
            SOFT,
        )
    # Wheels and wire spokes. Build the rear wheel before the frame.
    for cx in (201, 514):
        cy, r = 359, 77
        circle(cx, cy, r, 8)
        circle(cx, cy, r - 5, 2.5, BONE)
        circle(cx, cy, r - 8, 1.5, SOFT)
        for i in range(12):
            a = pi * i / 12 + 0.07
            dx, dy = (r - 9) * cos(a), (r - 9) * sin(a)
            line(f"M{cx-dx} {cy-dy} L{cx+dx} {cy+dy}", 1.05, SOFT)
        solid(cx, cy, 7, INK)
        solid(cx, cy, 3, BONE)
    # Chain runs, frame tubes, mudguards and seat.
    line("M202 353 L333 343 Q354 341 355 359 Q354 373 339 374 L201 365", 2.3)
    for path, width in [
        ("M202 359 L294 249 L340 358 L202 359", 8),
        ("M294 251 L451 239 L340 358", 9),
        ("M459 228 Q475 285 514 359", 8),
    ]:
        line(path, width + 2.5)
        line(path, width, TEAL)
    line("M212 277 Q165 271 133 317", 3, INK)
    line("M471 284 Q529 255 573 307", 3, INK)
    line("M302 253 L285 218", 4.8)
    paint(
        "M260 216 Q268 207 285 211 Q298 216 321 214 Q326 221 306 225 Q284 225 264 221 Z",
        RED,
        2.5,
        brush=6,
    )
    line("M456 242 L449 215 L472 206 C486 200 492 206 487 215 L476 219", 4.6)
    line("M474 205 Q485 199 489 208 Q489 214 478 218", 6, RED)
    # Burnished ring and offset pedal positions.
    circle(340, 357, 15, 3.6)
    circle(340, 357, 11, 1.5, SOFT)
    for a in (0, 2.1, 4.2):
        line(f"M340 357 L{340+13*cos(a)} {357+13*sin(a)}", 2.4)
    line("M313 376 L340 357 L368 334", 4.5)
    line("M303 377 L324 377 M359 333 L380 333", 4)
    # Far leg and foot first.
    leg2 = "M323 215 Q338 225 336 243 L327 269 Q325 275 333 278 L359 295 L366 323 Q373 325 381 330 Q374 333 363 330 L359 328 L352 301 L318 284 Q310 278 312 268 L319 238 L311 225 Z"
    paint(leg2, GOLD, 2.7, brush=5.5)
    # Near leg is visibly bent at the hock and rests on the forward pedal.
    leg1 = "M292 216 Q313 215 309 230 L282 267 Q277 274 279 283 L305 350 L310 365 Q318 367 327 373 Q318 375 312 372 Q310 377 304 373 L297 370 L294 355 L266 284 Q261 274 268 264 L285 232 Z"
    paint(leg1, ORANGE, 2.8, brush=5.5)
    line("M273 276 Q273 281 277 285 M314 370 L319 372", 1.2, RED)
    # Bird silhouette. Body, neck and head meet in one uninterrupted contour.
    body = "M169 127 Q192 145 222 150 Q253 148 273 141 Q294 136 310 132 Q320 125 327 108 Q328 94 338 77 Q333 80 328 80 Q337 68 350 63 Q341 64 337 62 Q351 49 380 53 Q402 55 413 74 Q419 88 411 101 Q403 112 391 118 Q375 129 375 145 Q377 162 364 181 Q361 204 339 217 Q316 237 286 232 Q254 230 235 215 Q210 205 195 182 L156 156 Q170 158 185 163 L145 135 Q164 140 182 148 Z"
    paint(body, PAPER, 3.4, brush=8)
    # Shaded belly lifts the folded flight feathers.
    paint(
        "M205 181 Q229 202 256 208 Q285 219 315 210 Q338 201 355 186 Q346 211 322 223 Q295 234 270 226 Q226 218 205 181 Z",
        SHADE,
        0,
        brush=7,
    )
    line("M196 181 Q224 216 258 224 Q291 238 317 224", 2.1)
    wing = "M170 145 Q197 158 223 159 Q249 151 271 155 Q299 161 310 173 Q297 180 288 180 Q291 186 277 187 Q274 193 261 193 Q249 194 236 188 Q222 184 203 173 Z"
    paint(wing, BONE, 2.4, brush=6)
    for feather in [
        "M177 151 Q221 169 255 173",
        "M205 165 Q244 181 275 181",
        "M226 178 Q251 187 263 187",
        "M248 160 Q269 162 279 169",
        "M272 163 Q287 166 294 172",
        "M321 126 Q317 141 304 149",
        "M328 123 Q323 142 320 146",
    ]:
        line(feather, 1.3, SOFT)
    # Iconic long bill and expandable peach pouch.
    pouch = "M405 87 Q444 93 483 94 L589 98 Q588 104 581 107 Q542 110 514 124 Q483 143 448 144 Q421 143 406 126 Q395 112 395 103 Z"
    paint(pouch, GOLD, 2.8, brush=7)
    paint(
        "M410 119 Q441 133 465 130 Q502 122 532 110 Q495 136 460 141 Q428 147 410 119 Z",
        ORANGE,
        0,
        brush=5.5,
    )
    line("M406 121 Q424 143 450 144 Q478 146 512 126", 2.0)
    for rib in [
        "M421 102 Q423 120 435 130",
        "M435 102 Q436 124 449 134",
        "M449 103 Q451 119 460 130",
        "M463 103 Q466 116 475 125",
        "M479 104 Q481 113 486 119",
        "M498 103 L502 111",
    ]:
        line(rib, 1.2, RED)
    bill = "M403 78 Q434 79 475 85 Q535 92 582 89 Q590 89 590 96 L587 105 Q585 109 583 106 L583 100 Q507 104 459 100 Q425 98 400 96 Q394 92 397 86 Z"
    paint(bill, GOLD, 2.8, brush=5.4)
    line("M410 85 Q449 87 475 90 Q528 96 572 94", 1.25, PAPER)
    line("M404 92 Q414 91 418 92", 2.2)
    # Eye ring, iris, glint and crown contour marks.
    circle(387, 77, 6.8, 2.1, SOFT)
    solid(388, 77, 4.1, INK)
    solid(389, 75.5, 1.4, PAPER)
    line("M369 69 Q378 63 389 66", 1.7)
    line("M343 81 Q356 74 363 76 M338 88 Q347 83 354 84", 1.45, SOFT)
    # Breezy neckerchief joins the shoulders and the wing reaching the handlebars.
    paint("M331 115 Q341 120 357 127 L349 137 Q333 135 318 127 Z", TEAL, 2.3, brush=5)
    paint(
        "M326 123 Q306 101 290 106 Q277 110 268 104 Q279 118 295 115 Q308 116 321 130 Z",
        TEAL,
        2,
        brush=5,
    )
    paint(
        "M323 128 Q306 124 294 133 L275 131 Q286 141 301 139 Q315 130 325 136 Z", TEAL, 2, brush=4.5
    )
    line("M331 121 L347 129 M287 111 Q301 108 307 114", 1.3, PAPER)
    grip = "M331 150 Q341 145 350 157 Q365 176 393 190 Q409 197 427 198 Q441 202 453 204 Q466 203 475 207 Q475 210 462 211 Q470 212 467 215 Q458 216 447 212 Q417 211 388 207 Q352 201 326 182 Q312 173 317 163"
    paint(grip + " Q322 153 331 150 Z", BONE, 2.65, brush=6.5)
    line("M348 178 Q371 192 400 199 M344 182 Q363 196 385 201 M426 205 L447 208", 1.35, SOFT)
    # Small motion lines keep the posture lively.
    line("M110 229 Q125 227 143 228 M120 236 L136 235", 1.65, SOFT)
    return strokes
