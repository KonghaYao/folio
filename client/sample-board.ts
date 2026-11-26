import { drawShape, type BoardRecord, type ShapeRecord } from '@quickdrawjs/core';
import { boardPath, createBoard, deleteBoard, getBoard, request, type Board } from './api';
import type { BoardCanvas } from './canvas';
import type { Renderer } from './canvas/sdk';

interface Panel {
  name: string;
  box: number[];
}
interface Wash extends Panel {
  kind: 'wash';
  color: string;
  alphas: number[];
  layers: string[];
}
interface Lettering extends Panel {
  kind: 'label';
  layers: string[];
}
interface Connector {
  kind: 'edge';
  name: string;
  points: number[][];
  arrow: boolean;
}
type Element = Wash | Lettering | Connector;

const template = 'agent-design-v1';
const toPage = (x: number, y: number) => ({ x: (x - 24) * 2, y: (y - 56) * 2 });
const paintCache = new WeakMap<object, Path2D[]>();
const validPath = (d: unknown): d is string =>
  typeof d === 'string' && d.length <= 130000 && /^[MZ0-9, .-]*$/.test(d);
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

function nativePaint(
  ctx: CanvasRenderingContext2D,
  shape: ShapeRecord,
  options: Parameters<Renderer>[2],
) {
  drawShape(ctx, { ...shape, x: 0, y: 0, rot: 0 }, options);
}

/** Editable text keeps its original hand only while the transcription matches. */
const paintReference: Renderer = (ctx, shape, options) => {
  const p = shape.props;
  const design = p.trace;
  const text = shape.type === 'text';
  if (
    !design ||
    typeof design !== 'object' ||
    !finite(design.w) ||
    !finite(design.h) ||
    (text && (p.text !== design.original || !finite(design.scale)))
  ) {
    nativePaint(ctx, shape, options);
    return;
  }
  if (text && options.hideText === 'text') return;
  let paths = paintCache.get(design);
  if (!paths) {
    if (!Array.isArray(design.paths) || design.paths.length > 3 || !design.paths.every(validPath)) {
      nativePaint(ctx, shape, options);
      return;
    }
    const outlines: Path2D[] = design.paths.map((d: string) => new Path2D(d));
    // Nested color bands share a pigment but touch the paper only once. Multiply
    // each band against the grid to preserve its texture at every zoom level.
    paths = text
      ? outlines
      : outlines.map((outline, index) => {
          const band = new Path2D(outline);
          if (outlines[index + 1]) band.addPath(outlines[index + 1]);
          return band;
        });
    paintCache.set(design, paths!);
  }
  const stroke =
    options.theme.colors[p.color as keyof typeof options.theme.colors]?.stroke ?? '#202320';
  const multiplier = text ? (p.scale || 1) / design.scale : 1;
  ctx.save();
  ctx.scale(text ? multiplier : p.w / design.w, text ? multiplier : p.h / design.h);
  ctx.fillStyle = stroke;
  if (!text) ctx.globalCompositeOperation = 'multiply';
  const global = ctx.globalAlpha;
  const opacity = text
    ? [0.28, 0.44, 0.6]
    : paths!.map((_, index) =>
        Math.max(0, Math.min(1, Number(design.alphas?.[index]) || Number(design.alpha) || 0.7)),
      );
  paths!.forEach((path, index) => {
    ctx.globalAlpha = global * opacity[index];
    ctx.fill(path, 'evenodd');
  });
  ctx.restore();
};

export function registerSampleRenderers(canvas: BoardCanvas) {
  canvas.editor.registerRenderer('reference-wash', paintReference);
  canvas.editor.registerRenderer('reference-lettering', paintReference);
}

function objectsFrom(elements: Element[]): Record<string, BoardRecord> {
  const result: Record<string, BoardRecord> = {};
  let serial = 0;
  const put = (
    type: ShapeRecord['type'],
    x: number,
    y: number,
    props: ShapeRecord['props'],
    rank: number,
  ) => {
    const id = 'shape:agent-design-' + ++serial;
    result[id] = {
      id,
      typeName: 'shape',
      type,
      ...toPage(x, y),
      rot: 0,
      z: rank + serial,
      props: { ...props, template },
    };
  };
  for (const element of elements) {
    if (element.kind === 'edge') {
      const groupId = 'agent-edge-' + serial;
      let i = 1;
      for (; i < element.points.length; i++) {
        const [x, y] = element.points[i - 1],
          [x2, y2] = element.points[i];
        put(
          i === element.points.length - 1 && element.arrow ? 'arrow' : 'line',
          x,
          y,
          {
            dx: (x2 - x) * 2,
            dy: (y2 - y) * 2,
            bend: 0,
            dash: 'solid',
            color: '#575953',
            size: 's',
            description: element.name,
            ...(element.points.length > 2 ? { groupId } : {}),
          },
          1000,
        );
      }
      continue;
    }
    const [x, y, right, bottom] = element.box;
    const w = (right - x) * 2,
      h = (bottom - y) * 2;
    if (element.kind === 'wash') {
      put(
        'geo',
        x,
        y,
        {
          geo: 'rectangle',
          w,
          h,
          color: element.color,
          fill: 'solid',
          size: 'm',
          dash: 'draw',
          kind: 'reference-wash',
          description: element.name,
          trace: { w, h, alphas: element.alphas, paths: element.layers },
        },
        0,
      );
    } else {
      const scale = h / (20 * 1.32);
      put(
        'text',
        x,
        y,
        {
          text: element.name,
          color: '#161916',
          font: 'draw',
          size: 's',
          scale,
          w,
          autosize: false,
          kind: 'reference-lettering',
          trace: { original: element.name, w, h, scale, paths: element.layers },
        },
        2000,
      );
    }
  }
  return result;
}

export function isAgentDesignSample(board: Board): boolean {
  return Object.values(board.items).some(
    (record) => record.typeName === 'shape' && record.props.template === template,
  );
}

/** Match the reference canvas even when the app toolbar occupies part of the viewport. */
export function frameAgentDesign(canvas: BoardCanvas) {
  const box = canvas.editor.container.getBoundingClientRect();
  const ratio = Math.min(window.innerWidth / 1000, window.innerHeight / 716);
  const z = 0.25 * ratio;
  const dx = (window.innerWidth - 1000 * ratio) / 2;
  canvas.editor.setCamera({ x: (dx - box.left) / z, y: -box.top / z, z });
}

export async function createAgentDesignSample(): Promise<Board> {
  const { default: source } = await import('./sample-design.json');
  const put = objectsFrom(source as Element[]);
  const board = await createBoard('Agent Design');
  try {
    await request(boardPath(board.id) + '/ops', 'POST', {
      opId: 'initialize-agent-design-v1',
      baseRev: 0,
      put,
    });
    return await getBoard(board.id);
  } catch (error) {
    await deleteBoard(board.id).catch(() => {});
    throw error;
  }
}
