import type { ShapeRecord } from '@quickdrawjs/core';
import { readAsset } from '../asset-cache';

export interface Attachment {
  name: string;
  url: string;
  mime: string;
}

export function webLink(input: string) {
  const link = new URL(input);
  if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password)
    throw new Error('Use an HTTP or HTTPS link.');
  return link.href;
}
export function assetUrl(input: string) {
  const url = new URL(input, location.href);
  if (
    url.origin !== location.origin ||
    !/^\/api\/boards\/[\w-]+\/assets\/[\w-]+$/.test(url.pathname)
  )
    throw new Error('Unknown board attachment.');
  return url.pathname;
}
export async function imageData(url: string): Promise<HTMLImageElement> {
  const path = /^\/api\/boards\//.test(url) ? assetUrl(url) : null;
  const src = path ? URL.createObjectURL(await readAsset(path)) : url;
  const image = new Image();
  try {
    image.src = src;
    await image.decode();
    return image;
  } finally {
    if (path) URL.revokeObjectURL(src);
  }
}

export function paintCard(ctx: CanvasRenderingContext2D, shape: ShapeRecord) {
  const { w, h, attachment, label, url } = shape.props;
  const link = shape.props.kind === 'link';
  const title = String(link ? label : attachment?.name);
  const subtitle = String(link ? url : attachment?.mime || 'File');
  ctx.fillStyle = '#fffefb';
  ctx.strokeStyle = '#d5d5cd';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, Math.min(9, w / 2, h / 2));
  ctx.fill();
  ctx.stroke();
  ctx.clip();
  const scale = Math.min(1, w / 210, h / 70);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#e8eee5';
  ctx.fillRect(14, 14, 40, 40);
  ctx.fillStyle = '#3f6256';
  ctx.textAlign = 'center';
  ctx.font = 'bold 11px sans-serif';
  const type = link
    ? 'URL'
    : String(attachment?.name ?? '')
        .split('.')
        .pop()
        ?.slice(0, 4)
        .toUpperCase();
  ctx.fillText(type || 'FILE', 34, 38);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#233530';
  ctx.font = '600 15px sans-serif';
  ctx.fillText(title, 68, 32);
  ctx.fillStyle = '#64716a';
  ctx.font = '12px sans-serif';
  ctx.fillText(subtitle, 68, 51);
}

export function openCard(shape: ShapeRecord) {
  if (shape.props.kind === 'link') {
    window.open(webLink(shape.props.url), '_blank', 'noopener,noreferrer');
    return;
  }
  const file = shape.props.attachment as Attachment;
  if (!file) return;
  const url = assetUrl(file.url);
  const dialog = document.createElement('dialog');
  dialog.className = 'folio-asset-dialog';
  const heading = document.createElement('h2');
  heading.textContent = file.name;
  const close = document.createElement('button');
  close.textContent = '关闭';
  close.onclick = () => dialog.close();
  const footer = document.createElement('div');
  const download = document.createElement('a');
  download.textContent = '下载原文件';
  download.href = url;
  download.download = file.name;
  footer.append(download, close);
  dialog.append(heading);
  const kind = file.mime.split('/')[0];
  let detached = false,
    source: Promise<string> | undefined,
    local: string | undefined;
  let sourceBlob: Promise<Blob> | undefined, disposePdf: (() => void) | undefined;
  const contents = () => (sourceBlob ??= readAsset(url));
  const localUrl = () =>
    (source ??= contents().then((blob) => {
      if (detached) throw new Error('Preview closed');
      local = URL.createObjectURL(blob);
      download.href = local;
      return local;
    }));
  const report = () => {
    if (detached || dialog.querySelector('[role=status]')) return;
    const message = document.createElement('p');
    message.setAttribute('role', 'status');
    message.textContent = '暂时无法读取此附件。';
    dialog.insertBefore(message, footer);
  };
  download.onclick = (e) => {
    if (local) return;
    e.preventDefault();
    void localUrl()
      .then(() => download.click())
      .catch(report);
  };
  if (kind === 'image' || kind === 'video' || kind === 'audio') {
    const player = document.createElement(kind === 'image' ? 'img' : kind);
    if (player instanceof HTMLMediaElement) {
      player.controls = true;
      if (navigator.onLine) {
        player.src = url;
        // Stream immediately with HTTP range support; retain a bounded offline copy after playback begins.
        player.addEventListener(
          'loadeddata',
          () => {
            void localUrl().catch(() => {});
          },
          { once: true },
        );
        player.addEventListener(
          'error',
          () => {
            void localUrl()
              .then((src) => {
                player.src = src;
              })
              .catch(report);
          },
          { once: true },
        );
      } else
        void localUrl()
          .then((src) => {
            player.src = src;
          })
          .catch(report);
    } else
      void localUrl()
        .then((src) => {
          player.src = src;
        })
        .catch(report);
    if (player instanceof HTMLImageElement) player.alt = file.name;
    dialog.append(player);
  } else if (file.mime === 'application/pdf') {
    const surface = document.createElement('section');
    dialog.append(surface);
    const openCanvasReader = async () => {
      const [reader, bytes] = await Promise.all([
        import('./pdf-preview'),
        contents().then((blob) => blob.arrayBuffer()),
      ]);
      if (!detached) {
        surface.replaceChildren();
        disposePdf = reader.mountPdfPreview(surface, new Uint8Array(bytes));
      }
    };
    if (navigator.pdfViewerEnabled) {
      // Browser PDF plugins are disabled inside sandboxed iframe elements.
      // Hand the native reader only a PDF-typed blob with a PDF signature.
      const frame = document.createElement('iframe');
      frame.title = file.name;
      const fallback = document.createElement('button');
      fallback.type = 'button';
      fallback.textContent = '使用画布阅读';
      fallback.onclick = () => {
        void openCanvasReader().catch(report);
      };
      surface.append(frame, fallback);
      void contents()
        .then(async (blob) => {
          const header = await blob.slice(0, 1024).text();
          if (blob.type !== 'application/pdf' || !header.includes('%PDF-')) {
            await openCanvasReader();
            return;
          }
          const src = await localUrl();
          if (!detached) frame.src = src;
        })
        .catch(report);
    } else void openCanvasReader().catch(report);
  }
  if (
    !['audio', 'image', 'video', 'application'].includes(kind) ||
    (kind === 'application' && file.mime !== 'application/pdf')
  )
    void localUrl().catch(report);
  dialog.append(footer);
  dialog.addEventListener(
    'close',
    () => {
      detached = true;
      disposePdf?.();
      dialog.remove();
      if (local) URL.revokeObjectURL(local);
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
}
