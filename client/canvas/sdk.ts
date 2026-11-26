/** Narrow compatibility surface for gesture hooks in the pinned Quickdraw 0.3.0.
 * The public Editor owns picking, gestures, IME editing, transforms and history.
 * This boundary keeps SDK internals out of the document and UI modules. */
import { Editor, type Camera, type EditorOptions, type ShapeRecord } from '@quickdrawjs/core';

export type Point = { x: number; y: number };
export type Session = {
  type: string;
  id: string;
  last?: Point;
  hits?: Set<string>;
  which?: string;
  trail?: number[];
};
interface QuickdrawHooks extends Editor {
  session: Session | null;
  editing: { id: string; field: string } | null;
  _drawGrid(
    ctx: CanvasRenderingContext2D,
    cam: Camera,
    width: number,
    height: number,
    dpr: number,
  ): void;
  _renderOverlay(w: number, h: number, dpr: number): void;
  _beginErase(p: Point): void;
  _extendErase(p: Point): void;
  _endErase(): void;
  _beginDraw(e: PointerEvent, p: Point): void;
  _extendDraw(e: PointerEvent, p: Point): void;
  _endDraw(): void;
  _endLineish(): void;
  _endPointer(e: PointerEvent): void;
  _pointerUp(e: PointerEvent): void;
  _abortForPinch(): void;
  _dblClick(e: MouseEvent): void;
  _startTextEdit(id: string, field: string, opts?: { fresh?: boolean }): void;
  _commitText(): void;
}
export const QuickdrawEditor = Editor as unknown as {
  new (options: EditorOptions): QuickdrawHooks;
};
export type ShapePaintOptions = Parameters<typeof import('@quickdrawjs/core').drawShape>[2] & {
  hideText?: string | null;
};
export type Renderer = (
  ctx: CanvasRenderingContext2D,
  shape: ShapeRecord,
  opts: ShapePaintOptions,
) => void;
