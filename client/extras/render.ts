import { pageBounds, type Bounds, type Editor } from '@quickdrawjs/core';
import type { CanvasRenderer } from '../canvas/renderer';
import { cameraFor } from './scenes';

export type ExportEditor = Editor & Pick<CanvasRenderer, 'prepareImages'>;

const MAX_SIDE = 3072;
const MAX_PIXELS = 6_000_000;

export function exportSize(bounds: Bounds, density = 2): { width: number; height: number } {
  const scale = Math.min(
    density,
    MAX_SIDE / Math.max(bounds.w, bounds.h),
    Math.sqrt(MAX_PIXELS / (bounds.w * bounds.h)),
  );
  return {
    width: Math.max(1, Math.round(bounds.w * scale)),
    height: Math.max(1, Math.round(bounds.h * scale)),
  };
}

export function renderFrame(editor: Editor, canvas: HTMLCanvasElement, bounds: Bounds): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('浏览器无法创建绘图画布');
  editor.renderScene(
    context,
    cameraFor(bounds, canvas.width, canvas.height),
    canvas.width,
    canvas.height,
  );
}

async function renderExport(editor: ExportEditor, bounds: Bounds): Promise<HTMLCanvasElement> {
  const { width, height } = exportSize(bounds);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const images = editor.store.shapes().filter((shape) => {
    if (shape.type !== 'image') return false;
    const b = pageBounds(shape);
    return (
      b.x <= bounds.x + bounds.w &&
      b.x + b.w >= bounds.x &&
      b.y <= bounds.y + bounds.h &&
      b.y + b.h >= bounds.y
    );
  });
  await Promise.all([editor.prepareImages(images, true), document.fonts.ready]);
  renderFrame(editor, canvas, bounds);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('无法生成图像'))), type, 0.94);
  });
}

export async function makePng(editor: ExportEditor, bounds: Bounds): Promise<Blob> {
  return encode(await renderExport(editor, bounds), 'image/png');
}

export async function makePdf(
  editor: ExportEditor,
  frames: readonly Bounds[],
  title: string,
): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer('Folio');
  for (const bounds of frames) {
    const canvas = await renderExport(editor, bounds);
    const jpeg = await encode(canvas, 'image/jpeg');
    const image = await pdf.embedJpg(await jpeg.arrayBuffer());
    const scale = 842 / Math.max(canvas.width, canvas.height);
    const w = Math.max(1, canvas.width * scale);
    const h = Math.max(1, canvas.height * scale);
    pdf.addPage([w, h]).drawImage(image, { x: 0, y: 0, width: w, height: h });
    canvas.width = canvas.height = 1;
  }
  const bytes = await pdf.save();
  return new Blob([new Uint8Array(bytes)], { type: 'application/pdf' });
}
