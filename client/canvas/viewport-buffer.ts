import type { Camera } from '@quickdrawjs/core';

type Painter = (ctx: CanvasRenderingContext2D, cam: Camera, width: number, height: number) => void;
interface Raster {
  surface: HTMLCanvasElement;
  camera: Camera;
  dpr: number;
  width: number;
  height: number;
  revision: number;
  style: string;
}

/** One bounded view raster. Exports and final subpixel frames use vector rendering. */
export class ViewportBuffer {
  private image?: Raster;
  private lastZoom?: number;
  private settle?: ReturnType<typeof setTimeout>;
  private exact = false;

  invalidate() {
    this.image = undefined;
    this.lastZoom = undefined;
    this.exact = false;
    clearTimeout(this.settle);
  }

  append(previous: number, revision: number, paint: Painter) {
    const image = this.image;
    if (!image || image.revision !== previous) return;
    const ctx = image.surface.getContext('2d');
    if (!ctx) return;
    paint(ctx, image.camera, image.surface.width / image.dpr, image.surface.height / image.dpr);
    image.revision = revision;
  }

  draw(
    target: CanvasRenderingContext2D,
    camera: Camera,
    width: number,
    height: number,
    dpr: number,
    revision: number,
    style: string,
    dense: () => boolean,
    paint: Painter,
    repaint: () => void,
  ): boolean {
    const w = Math.round(width * dpr),
      h = Math.round(height * dpr);
    const previous = this.image;
    const sameZoom = this.lastZoom === camera.z;
    this.lastZoom = camera.z;
    const factor = camera.z * dpr;
    if (
      previous &&
      previous.camera.z === camera.z &&
      previous.dpr === dpr &&
      previous.width === w &&
      previous.height === h &&
      previous.revision === revision &&
      previous.style === style
    ) {
      const x = (previous.camera.x - camera.x) * factor,
        y = (previous.camera.y - camera.y) * factor;
      if (
        x >= -1e-6 &&
        y >= -1e-6 &&
        x + w <= previous.surface.width + 1e-6 &&
        y + h <= previous.surface.height + 1e-6
      ) {
        const aligned = Math.abs(x - Math.round(x)) < 1e-5 && Math.abs(y - Math.round(y)) < 1e-5;
        if (aligned || !this.exact) {
          target.setTransform(1, 0, 0, 1, 0, 0);
          target.drawImage(
            previous.surface,
            aligned ? Math.round(x) : x,
            aligned ? Math.round(y) : y,
            w,
            h,
            0,
            0,
            w,
            h,
          );
          if (!aligned) {
            clearTimeout(this.settle);
            this.settle = setTimeout(() => {
              this.exact = true;
              repaint();
            }, 120);
          }
          return true;
        }
      }
    }
    this.exact = false;
    // During continuous zoom avoid building a raster at each intermediate scale.
    if (!sameZoom || w < 1 || h < 1 || w * h > 6_000_000 || !dense()) return false;
    const budget = Math.sqrt(6_000_000 / (w * h));
    const slack = Math.max(0, (budget - 1) / 2);
    const px = Math.min(
      Math.floor(w * slack),
      camera.z < 0.25 ? Math.round(w * 0.55) : Math.round(128 * dpr),
    );
    const py = Math.min(
      Math.floor(h * slack),
      camera.z < 0.25 ? Math.round(h * 0.55) : Math.round(128 * dpr),
    );
    const surface = previous?.surface ?? document.createElement('canvas');
    if (surface.width !== w + 2 * px) surface.width = w + 2 * px;
    if (surface.height !== h + 2 * py) surface.height = h + 2 * py;
    const context = surface.getContext('2d');
    if (!context) return false;
    const expanded = { x: camera.x + px / factor, y: camera.y + py / factor, z: camera.z };
    paint(context, expanded, surface.width / dpr, surface.height / dpr);
    this.image = { surface, camera: expanded, dpr, width: w, height: h, revision, style };
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.drawImage(surface, px, py, w, h, 0, 0, w, h);
    return true;
  }
}
