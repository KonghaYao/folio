import { newId, type ShapeRecord, type ToolId } from '@quickdrawjs/core';
import { openCard } from './attachments';
import { appendTrail, cutFor, lassoHit, projectToRuler } from './assists';
import { adoptClipboardFiles, cloneSelection, type ClipboardData } from './clone';
import { readSample, type Brush, type Ink } from './ink';
import { CanvasRenderer } from './renderer';
import { type Point } from './sdk';
import { BoardStore } from './store';

const SEGMENT_SAMPLES = 2048;

export class BoardEditor extends CanvasRenderer {
  declare store: BoardStore;
  brush: Brush = 'pen';
  inkWidth = 4;
  inkColor = '#26344b';
  private pointer = -1;
  boardId?: string;
  disposed = false;
  assist: 'lasso' | 'partial' | null = null;
  rulerAngle: number | null = null;
  eraserRadius = 10;
  private trail: Point[] = [];
  private rulerOrigin?: Point;
  private openers = new Map<string, (s: ShapeRecord) => void>([
    ['attachment', openCard],
    ['link', openCard],
  ]);

  pagePoint(e: Pick<PointerEvent, 'clientX' | 'clientY'>): Point {
    const r = this.container.getBoundingClientRect();
    return this.screenToPage(e.clientX - r.left, e.clientY - r.top);
  }

  registerOpenHandler(kind: string, open: (s: ShapeRecord) => void) {
    this.openers.set(kind, open);
  }

  override _dblClick(e: MouseEvent) {
    const p = this.pagePoint(e);
    const hit = this.hitTest(p.x, p.y);
    const open = hit && this.openers.get(hit.props.kind);
    if (hit && open && (this.tool === 'select' || this.readonly)) {
      this._commitText();
      open(hit);
      return;
    }
    super._dblClick(e);
  }

  override _startTextEdit(id: string, field: string, opts?: { fresh?: boolean }) {
    const r = this.store.get(id);
    if (r?.typeName === 'shape' && (r.props.locked || this.openers.has(r.props.kind))) return;
    super._startTextEdit(id, field, opts);
  }

  override duplicateSelection(offset = 16) {
    if (this.readonly) return;
    const shapes = this.shapesSorted().filter((s) => this.selection.has(s.id));
    this.setSelection(cloneSelection(this.store, { shapes }, offset));
  }

  _pasteShapes(data: ClipboardData) {
    if (this.readonly || !Array.isArray(data?.shapes)) return;
    void adoptClipboardFiles(data, this.boardId)
      .then((local) => {
        if (this.disposed || this.readonly) return;
        const pasted = cloneSelection(this.store, local, 16);
        if (pasted.length) {
          this.setTool('select');
          this.setSelection(pasted);
        }
      })
      .catch(() => {
        if (this.disposed) return;
        const dialog = document.createElement('dialog');
        dialog.className = 'folio-asset-dialog';
        const message = document.createElement('p'),
          close = document.createElement('button');
        message.textContent = '无法复制附件。请确认仍有原画板的访问权限，并在联网后重试。';
        close.textContent = '关闭';
        close.onclick = () => dialog.close();
        dialog.append(message, close);
        dialog.onclose = () => dialog.remove();
        document.body.append(dialog);
        dialog.showModal();
      });
  }

  onCaptureLost(e: PointerEvent) {
    if (!this.draft || this.pointer !== e.pointerId) return;
    this._abortForPinch();
    super._endPointer(e);
  }

  override setSelection(ids: string[]) {
    const groups = new Set<string>();
    for (const id of ids) {
      const rec = this.store.get(id);
      if (rec?.typeName === 'shape' && rec.props.groupId) groups.add(rec.props.groupId);
    }
    if (!groups.size) {
      super.setSelection(ids);
      return;
    }
    const expanded = new Set(ids);
    for (const s of this.store.shapes()) if (groups.has(s.props.groupId)) expanded.add(s.id);
    super.setSelection([...expanded]);
  }

  override setTool(tool: ToolId) {
    this.assist = null;
    super.setTool(tool);
  }

  setAssist(mode: 'object' | 'lasso' | 'partial') {
    this.setTool('eraser');
    this.assist = mode === 'object' ? null : mode;
    this.emit('tool');
    this.requestRender();
  }

  override _beginErase(p: Point) {
    if (!this.assist) {
      super._beginErase(p);
      return;
    }
    this.trail = [p];
    this.session = { type: 'erasing', id: '', hits: new Set(), trail: [], last: p };
    this.requestRender();
  }
  override _extendErase(p: Point) {
    if (!this.assist) {
      super._extendErase(p);
      return;
    }
    appendTrail(this.trail, p, this.camera.z);
    this.requestRender();
  }
  override _endErase() {
    if (!this.assist) {
      super._endErase();
      return;
    }
    this.session = null;
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const point of this.trail) {
      left = Math.min(left, point.x);
      top = Math.min(top, point.y);
      right = Math.max(right, point.x);
      bottom = Math.max(bottom, point.y);
    }
    // cutFor permits a radius plus up to 2.5 stroke widths of reach.
    // Custom ink already has its width included in shapeBounds. Native ink defaults to 8.
    const pad = this.assist === 'partial' ? this.eraserRadius + 20 : 0;
    const candidates = this.store.shapesInBounds({
      x: left - pad,
      y: top - pad,
      w: right - left + pad * 2,
      h: bottom - top + pad * 2,
    });
    if (this.assist === 'lasso') {
      const picked = this.trail.length < 3 ? this.hitTest(this.trail[0].x, this.trail[0].y) : null;
      const ids = picked
        ? [picked.id]
        : candidates.filter((s) => lassoHit(s, this.trail)).map((s) => s.id);
      this.setTool('select');
      this.setSelection(ids);
    } else {
      this.store.transact(() => {
        for (const s of candidates) {
          const cut = cutFor(s, this.trail, this.eraserRadius);
          if (cut)
            this.store.update(s.id, { props: { erasures: [...(s.props.erasures ?? []), cut] } });
        }
      });
    }
    this.trail = [];
    this.requestRender();
  }

  override _renderOverlay(w: number, h: number, dpr: number) {
    super._renderOverlay(w, h, dpr);
    const ctx = this.overlay.getContext('2d')!;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.assist && this.trail.length) {
      const lasso = this.assist === 'lasso';
      ctx.lineWidth = lasso ? 1.5 : this.eraserRadius * 2 * this.camera.z;
      ctx.strokeStyle = lasso ? '#2e7254' : 'rgba(100,120,117,0.42)';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (lasso) ctx.setLineDash([5, 3]);
      ctx.beginPath();
      this.trail.forEach((p, i) => {
        const s = this.pageToScreen(p.x, p.y);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (lasso) {
        ctx.closePath();
        ctx.fillStyle = 'rgba(79,144,105,0.09)';
        ctx.fill();
      }
      ctx.stroke();
    }
    if (this.rulerAngle !== null && ['draw', 'highlight'].includes(this.tool)) {
      const origin = this.rulerOrigin
        ? this.pageToScreen(this.rulerOrigin.x, this.rulerOrigin.y)
        : { x: w / 2, y: h / 2 };
      const length = Math.hypot(w, h);
      ctx.translate(origin.x, origin.y);
      ctx.rotate((this.rulerAngle * Math.PI) / 180);
      ctx.strokeStyle = '#718c83';
      ctx.lineWidth = 1;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      ctx.moveTo(-length, 0);
      ctx.lineTo(length, 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  override _beginDraw(e: PointerEvent, p: Point) {
    if (this.draft) return;
    const sample = readSample(e, 0, 0);
    const brush = this.tool === 'highlight' ? 'marker' : this.brush === 'pencil' ? 'pencil' : 'pen';
    const ink: Ink = {
      version: 1,
      brush,
      color: this.inkColor,
      width: this.inkWidth,
      samples: [sample],
    };
    const id = newId();
    this.rulerOrigin = this.rulerAngle === null ? undefined : p;
    this.pointer = e.pointerId;
    this.pendingSegments = [];
    this.store.beginBatch();
    this.draft = {
      id,
      typeName: 'shape',
      type: brush === 'marker' ? 'highlight' : 'draw',
      x: p.x,
      y: p.y,
      z: this.store.maxZ() + 1,
      rot: 0,
      props: {
        ink,
        pts: [0, 0, sample[2]],
        color: this.styles.color,
        size: this.styles.size,
        dash: 'draw',
        isPen: e.pointerType === 'pen',
        done: false,
      },
    };
    this.session = { type: 'drawing', id, last: p };
    this.requestRender();
  }

  private append(e: PointerEvent) {
    let shape = this.draft;
    if (!shape) return;
    let ink = shape.props.ink as Ink;
    const raw = this.pagePoint(e);
    const p =
      this.rulerOrigin && this.rulerAngle !== null
        ? projectToRuler(this.rulerOrigin, raw, this.rulerAngle)
        : raw;
    const sample = readSample(e, p.x - shape.x, p.y - shape.y);
    const last = ink.samples[ink.samples.length - 1];
    if (sample.every((v, i) => v === last[i])) return;
    if (ink.samples.length >= SEGMENT_SAMPLES) {
      // Keep document operations bounded during a very long uninterrupted stroke.
      // One history batch makes all its segments undo together.
      const id = newId(),
        origin = { x: shape.x + last[0], y: shape.y + last[1] };
      this.pendingSegments.push({ ...shape, props: { ...shape.props, done: true } });
      const first = [...last] as typeof last;
      first[0] = 0;
      first[1] = 0;
      ink = { ...ink, samples: [first] };
      this.draft = shape = {
        ...shape,
        ...origin,
        id,
        z: this.store.maxZ() + this.pendingSegments.length + 1,
        props: { ...shape.props, pts: [0, 0, first[2]], ink },
      };
      if (this.session) this.session.id = id;
      sample[0] = p.x - origin.x;
      sample[1] = p.y - origin.y;
    }
    ink.samples.push(sample);
    shape.props.pts.push(sample[0], sample[1], sample[2]);
  }

  override _extendDraw(e: PointerEvent, _p: Point) {
    if (e.pointerId !== this.pointer) return;
    for (const sample of e.getCoalescedEvents?.() ?? []) this.append(sample);
    this.append(e);
    this.requestRender();
  }

  override _pointerUp(e: PointerEvent) {
    if (this.draft && this.pointer === e.pointerId) {
      if (e.type === 'pointercancel') this._abortForPinch();
      else {
        const raw = this.pagePoint(e),
          p =
            this.rulerOrigin && this.rulerAngle !== null
              ? projectToRuler(this.rulerOrigin, raw, this.rulerAngle)
              : raw;
        const samples: Ink['samples'] = this.draft.props.ink.samples;
        const last = samples[samples.length - 1];
        // The release event may be at an unreported endpoint with zero pressure.
        // Carry the final contact pressure there rather than producing a blob.
        const x = p.x - this.draft.x,
          y = p.y - this.draft.y;
        if (x !== last[0] || y !== last[1]) {
          samples.push([x, y, last[2], last[3], last[4], last[5], last[6]]);
          this.draft.props.pts.push(x, y, last[2]);
        }
      }
    }
    super._pointerUp(e);
  }

  override _endDraw() {
    const shape = this.draft;
    this.draft = undefined;
    this.session = null;
    this.pointer = -1;
    this.rulerOrigin = undefined;
    const records = [...this.pendingSegments];
    if (shape) records.push({ ...shape, props: { ...shape.props, done: true } });
    const previous = this.store.generation;
    // Concurrent edits can place an object above the tip while a local stroke is in flight.
    const canAppend =
      records.length > 0 &&
      records[0].z > this.store.maxZ() &&
      records.every((s) => s.type === records[0].type);
    this.store.transact(() => {
      for (const record of records) this.store.put(record);
    });
    if (canAppend && this.store.generation === previous + records.length)
      this.appendCommittedInk(previous, records);
    this.pendingSegments = [];
    this.store.endBatch();
    this.requestRender();
  }

  override _abortForPinch() {
    if (this.draft) {
      this.draft = undefined;
      this.pointer = -1;
      this.rulerOrigin = undefined;
      this.pendingSegments = [];
    }
    this.trail = [];
    super._abortForPinch();
    this.requestRender();
  }

  private bindEnds(id: string, which?: string) {
    const shape = this.store.get(id);
    if (shape?.typeName !== 'shape' || !['line', 'arrow'].includes(shape.type)) return;
    const end = { x: shape.x + shape.props.dx, y: shape.y + shape.props.dy };
    const bindings = { ...shape.props.bindings };
    for (const endpoint of ['start', 'end']) {
      if (which && which !== endpoint) continue;
      const anchor = this.store.anchorAt(endpoint === 'start' ? shape : end, 7 / this.camera.z);
      if (anchor) bindings[endpoint] = anchor;
      else delete bindings[endpoint];
    }
    if (Object.keys(bindings).length || shape.props.bindings)
      this.store.update(id, { props: { bindings } });
  }

  override _endLineish() {
    if (this.session) this.bindEnds(this.session.id);
    super._endLineish();
  }

  override _endPointer(e: PointerEvent) {
    if (e.type === 'pointercancel' && this.assist && this.session?.type === 'erasing')
      this._abortForPinch();
    if (this.session?.type === 'handle' && this.session.which !== 'bend')
      this.bindEnds(this.session.id, this.session.which);
    super._endPointer(e);
  }
}
