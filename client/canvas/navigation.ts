import type { Editor } from '@quickdrawjs/core';
import type { Point } from './sdk';

/** Quickdraw's readonly option disables its input router, including navigation. */
export function viewerNavigation(editor: Editor) {
  const host = editor.container,
    points = new Map<number, Point>();
  const scope = new AbortController(),
    options = { capture: true, signal: scope.signal };
  function measure() {
    const [a, b] = points.values();
    return !a
      ? null
      : !b
        ? { x: a.x, y: a.y, d: 0 }
        : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(b.x - a.x, b.y - a.y) };
  }
  function point(e: MouseEvent) {
    const rect = host.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  host.addEventListener(
    'pointerdown',
    (e) => {
      if (!editor.readonly || e.button > 1) return;
      e.preventDefault();
      points.set(e.pointerId, point(e));
      host.setPointerCapture(e.pointerId);
    },
    options,
  );
  host.addEventListener(
    'pointermove',
    (e) => {
      if (!editor.readonly || !points.has(e.pointerId)) return;
      const before = measure()!;
      points.set(e.pointerId, point(e));
      const after = measure()!;
      if (before.d > 0 && after.d > 0) editor.zoomAt(before.x, before.y, after.d / before.d);
      editor.pan(after.x - before.x, after.y - before.y);
    },
    options,
  );
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture'] as const)
    host.addEventListener(event, (e) => points.delete(e.pointerId), options);
  host.addEventListener(
    'wheel',
    (e) => {
      if (!editor.readonly) return;
      e.preventDefault();
      const p = point(e);
      if (e.ctrlKey || e.metaKey) editor.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.012));
      else editor.pan(-e.deltaX, -e.deltaY);
    },
    { ...options, passive: false },
  );
  return () => scope.abort();
}
