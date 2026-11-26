import type { Editor } from '@quickdrawjs/core';
import { currentCacheScope } from './offline';

interface Viewpoint {
  centerX: number;
  centerY: number;
  zoom: number;
}

/** A board's private viewpoint is stored in page coordinates so it survives window resizing. */
export function rememberViewport(
  boardId: string,
  editor: Editor,
  initialView: () => void,
): () => void {
  const scope = currentCacheScope();
  if (!scope) {
    initialView();
    return () => {};
  }
  let restored = false;
  const key = 'folio.viewport.1:' + scope + ':' + boardId;
  try {
    const saved: Viewpoint | null = JSON.parse(localStorage.getItem(key) || 'null');
    if (
      saved &&
      Number.isFinite(saved.centerX) &&
      Number.isFinite(saved.centerY) &&
      Number.isFinite(saved.zoom) &&
      saved.zoom > 0 &&
      saved.zoom <= 32
    ) {
      const { w, h } = editor.viewSize();
      restored = true;
      editor.setCamera({
        x: w / (2 * saved.zoom) - saved.centerX,
        y: h / (2 * saved.zoom) - saved.centerY,
        z: saved.zoom,
      });
    }
  } catch {
    /* Hardware storage denial leaves the board's initial framing in effect. */
  }

  if (!restored) initialView();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = undefined;
    if (currentCacheScope() !== scope) return;
    const { w, h } = editor.viewSize();
    if (!w || !h) return;
    const point = editor.screenToPage(w / 2, h / 2);
    const value: Viewpoint = { centerX: point.x, centerY: point.y, zoom: editor.camera.z };
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* Viewpoints are optional. */
    }
  };
  const off = editor.on('camera', () => {
    clearTimeout(timer);
    timer = setTimeout(save, 180);
  });
  window.addEventListener('pagehide', save);
  return () => {
    off();
    window.removeEventListener('pagehide', save);
    save();
  };
}
