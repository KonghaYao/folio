import {
  newId,
  type ColorId,
  type GeoId,
  type ShapeRecord,
  type SizeId,
  type ToolId,
} from '@quickdrawjs/core';
import { assetUrl, imageData, webLink, type Attachment } from './attachments';
import { BoardEditor } from './editor';
import { showDrawingOptions } from './options';
import { viewerNavigation } from './navigation';
import { paperTheme } from './renderer';
import { type Point } from './sdk';
import { BoardStore } from './store';
import './surface.css';

export type CanvasTool =
  | 'select'
  | 'hand'
  | 'pen'
  | 'pencil'
  | 'marker'
  | 'eraser'
  | 'laser'
  | 'shape'
  | 'line'
  | 'arrow'
  | 'text'
  | 'note';
const rawTools: Record<CanvasTool, ToolId> = {
  select: 'select',
  hand: 'hand',
  pen: 'draw',
  pencil: 'draw',
  marker: 'highlight',
  eraser: 'eraser',
  laser: 'laser',
  shape: 'geo',
  line: 'line',
  arrow: 'arrow',
  text: 'text',
  note: 'note',
};

export function createBoardCanvas(
  container: HTMLElement,
  options: { readonly?: boolean; boardId?: string } = {},
) {
  const store = new BoardStore();
  const editor = new BoardEditor({
    container,
    store,
    readonly: options.readonly,
    grid: 'dots',
    styles: { font: 'sans', color: 'black', size: 'm', dash: 'solid', fill: 'none' },
  });
  editor.boardId = options.boardId;
  editor.theme = paperTheme(editor.theme);
  editor.setTool(options.readonly ? 'hand' : 'select');
  const stopNavigation = viewerNavigation(editor);
  const refreshTextBounds = () => store.fontsChanged();
  document.fonts?.addEventListener('loadingdone', refreshTextBounds);
  const retryImages = () => editor.retryImages();
  window.addEventListener('online', retryImages);
  const captureLost = (e: PointerEvent) => editor.onCaptureLost(e);
  container.addEventListener('lostpointercapture', captureLost);
  let alive = true;
  editor.canvas.setAttribute('aria-label', '无限画布');
  editor.canvas.dataset.testid = 'drawing-surface';
  const center = () => {
    const { w, h } = editor.viewSize();
    return editor.screenToPage(w / 2, h / 2);
  };
  function select(shape: ShapeRecord) {
    store.put(shape);
    editor.setTool('select');
    editor.setSelection([shape.id]);
  }
  function card(kind: string, props: Record<string, unknown>, at: Point) {
    select({
      id: newId(),
      typeName: 'shape',
      type: 'geo',
      x: at.x - 130,
      y: at.y - 36,
      rot: 0,
      z: store.maxZ() + 1,
      props: {
        kind,
        geo: 'rectangle',
        w: 260,
        h: 72,
        size: 's',
        font: 'sans',
        dash: 'solid',
        color: 'grey',
        fill: 'solid',
        ...props,
      },
    });
  }
  return {
    editor,
    store,
    openDrawingOptions() {
      showDrawingOptions(editor);
    },
    getTool(): CanvasTool {
      if (editor.assist === 'lasso') return 'select';
      if (editor.tool === 'draw') return editor.brush === 'pencil' ? 'pencil' : 'pen';
      if (editor.tool === 'highlight') return 'marker';
      if (editor.tool === 'geo') return 'shape';
      return editor.tool;
    },
    setTool(tool: CanvasTool) {
      if (editor.readonly && tool !== 'hand') return;
      if (tool === 'pencil' || tool === 'pen' || tool === 'marker') editor.brush = tool;
      editor.setTool(rawTools[tool]);
    },
    setColor(value: string) {
      if (!/^#[\da-f]{6}$/i.test(value) || editor.readonly) return;
      editor.inkColor = value;
      store.transact(() => {
        editor.setStyle('color', value as ColorId);
        for (const id of editor.selection) {
          const s = store.get(id);
          if (s?.typeName === 'shape' && s.props.ink)
            store.update(id, { props: { ink: { ...s.props.ink, color: value } } });
        }
      });
    },
    setWidth(n: number) {
      if (!Number.isFinite(n) || editor.readonly) return;
      editor.inkWidth = Math.max(0.5, Math.min(128, n));
      const size: SizeId = n <= 3 ? 's' : n <= 5 ? 'm' : n <= 8 ? 'l' : 'xl';
      store.transact(() => {
        editor.setStyle('size', size);
        for (const id of editor.selection) {
          const s = store.get(id);
          if (s?.typeName === 'shape' && s.props.ink)
            store.update(id, { props: { ink: { ...s.props.ink, width: editor.inkWidth } } });
        }
      });
    },
    setShape(kind: GeoId) {
      if (!editor.readonly) editor.setGeoKind(kind);
    },
    setReadOnly(ro: boolean) {
      editor.setReadonly(ro);
      if (ro) editor.setTool('hand');
    },
    addLink(value: string, at = center()) {
      if (editor.readonly) return;
      const url = webLink(value);
      card('link', { url, label: new URL(url).hostname }, at);
    },
    async addAttachment(file: Attachment, at = center()) {
      if (editor.readonly) return;
      const attachment = { ...file, url: assetUrl(file.url) };
      if (!file.mime.startsWith('image/')) {
        card('attachment', { attachment }, at);
        return;
      }
      const image = await imageData(attachment.url).catch(() => null);
      if (!alive || editor.readonly || !container.isConnected) return;
      if (!image) {
        card('attachment', { attachment }, at);
        return;
      }
      const vp = editor.viewportPageBounds();
      const scale = Math.min(
        1,
        (vp.w * 0.6) / image.naturalWidth,
        (vp.h * 0.6) / image.naturalHeight,
      );
      const w = image.naturalWidth * scale,
        h = image.naturalHeight * scale,
        assetId = newId('asset');
      store.transact(() => {
        store.put({
          id: assetId,
          typeName: 'asset',
          src: attachment.url,
          w: image.naturalWidth,
          h: image.naturalHeight,
        });
        select({
          id: newId(),
          typeName: 'shape',
          type: 'image',
          x: at.x - w / 2,
          y: at.y - h / 2,
          rot: 0,
          z: store.maxZ() + 1,
          props: { w, h, assetId, kind: 'attachment', attachment },
        });
      });
    },
    destroy() {
      alive = false;
      editor.disposed = true;
      window.removeEventListener('online', retryImages);
      container.removeEventListener('lostpointercapture', captureLost);
      document.fonts?.removeEventListener('loadingdone', refreshTextBounds);
      stopNavigation();
      editor.destroy();
      store.disposeIndex();
    },
  };
}
export type BoardCanvas = ReturnType<typeof createBoardCanvas>;
