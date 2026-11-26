import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  version,
  type RenderTask,
} from 'pdfjs-dist';
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerSource;

/** A bitmap-only reader for browsers without an embedded PDF viewer.
 * The PDF's URLs, annotations, scripting and forms have no DOM surface. */
export function mountPdfPreview(container: HTMLElement, bytes: Uint8Array<ArrayBuffer>) {
  const view = document.createElement('section');
  view.className = 'folio-pdf-reader';
  const canvas = document.createElement('canvas');
  canvas.dataset.pdfPage = '';
  canvas.setAttribute('aria-label', 'PDF 页面');
  const navigation = document.createElement('nav');
  const previous = document.createElement('button'),
    next = document.createElement('button');
  previous.type = next.type = 'button';
  previous.dataset.pdfPrev = '';
  next.dataset.pdfNext = '';
  previous.textContent = '上一页';
  next.textContent = '下一页';
  const status = document.createElement('span');
  status.dataset.pdfStatus = '';
  status.setAttribute('aria-live', 'polite');
  status.textContent = '打开 PDF…';
  previous.disabled = next.disabled = true;
  navigation.append(previous, status, next);
  view.append(canvas, navigation);
  container.append(view);
  const resource = new URL('/pdf-resources/' + version + '/', location.origin).href;
  const documentTask = getDocument({
    data: bytes,
    cMapUrl: resource + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: resource + 'standard_fonts/',
    wasmUrl: resource + 'wasm/',
    iccUrl: resource + 'iccs/',
    useWorkerFetch: true,
    enableXfa: false,
    maxImageSize: 24_000_000,
    canvasMaxAreaInBytes: 64 * 1024 * 1024,
  });
  let disposed = false,
    generation = 0,
    pageNumber = 1,
    active: RenderTask | undefined;

  async function draw(n: number) {
    const ticket = ++generation;
    previous.disabled = next.disabled = true;
    try {
      const doc = await documentTask.promise;
      if (disposed || ticket !== generation) return;
      const page = await doc.getPage(n);
      if (disposed || ticket !== generation) return;
      const original = page.getViewport({ scale: 1 });
      const scale = Math.min(
        2,
        (innerWidth * 0.72) / original.width,
        (innerHeight * 0.6) / original.height,
      );
      const css = page.getViewport({ scale });
      const dpr = Math.min(devicePixelRatio || 1, 2, 2048 / Math.max(css.width, css.height));
      const viewport = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      canvas.style.width = css.width + 'px';
      canvas.style.height = css.height + 'px';
      active = page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE });
      await active.promise;
      if (disposed || ticket !== generation) return;
      pageNumber = n;
      canvas.dataset.pdfPage = String(n);
      status.textContent = n + ' / ' + doc.numPages;
      previous.disabled = n <= 1;
      next.disabled = n >= doc.numPages;
      page.cleanup();
    } catch (error) {
      if (!disposed && ticket === generation) {
        status.textContent =
          (error as Error)?.name === 'PasswordException'
            ? '受密码保护，请下载原文件。'
            : '无法预览此页，请下载原文件。';
      }
    }
  }
  previous.onclick = () => {
    void draw(pageNumber - 1);
  };
  next.onclick = () => {
    void draw(pageNumber + 1);
  };
  void draw(1);
  return () => {
    disposed = true;
    generation++;
    active?.cancel();
    void documentTask.destroy().catch(() => {});
    canvas.width = canvas.height = 1;
    view.remove();
  };
}
