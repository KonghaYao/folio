import type { Camera } from '@quickdrawjs/core';

// A 23.15-page-unit lattice projects to 5.79 CSS px at 25% zoom. Keep the
// contact size in screen space so the dots stay legible when the paper moves.
const PAGE_PITCH = 23.15;
const MIN_PITCH = 5;
const DOT_RADIUS = 1.635;

export class DottedPaper {
  private tile?: { key: string; pattern: CanvasPattern; size: number };

  paint(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    w: number,
    h: number,
    dpr: number,
    dark: boolean,
  ) {
    const basePitch = PAGE_PITCH * camera.z;
    // Drop alternate rows and columns when zoomed past the iPad's 25% view.
    // The surviving points stay fixed to page coordinates.
    const stride = Math.max(1, 2 ** Math.ceil(Math.log2(MIN_PITCH / basePitch)));
    const pitch = stride * basePitch;
    const size = Math.max(64, Math.ceil(pitch * dpr));
    const key = [pitch, size, dark].join(':');
    if (this.tile?.key !== key) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = size;
      const texture = tile.getContext('2d')!;
      const center = size / 2;
      const radius = (DOT_RADIUS * size) / pitch;
      const wash = texture.createRadialGradient(center, center, 0, center, center, radius);
      const color = dark ? '255,255,255' : '0,0,0';
      const contrast = dark ? 0.18 : 26 / 255;
      // The soft shoulder avoids a hard square edge when an iPad pixel clips
      // the tip of a dot. Coordinates are normalized radii and coverage.
      for (const [r, opacity] of [
        [0, 1],
        [0.16, 1],
        [0.32, 0.9],
        [0.48, 0.64],
        [0.63, 0.32],
        [0.78, 0.1],
        [0.92, 0.018],
        [1, 0],
      ])
        wash.addColorStop(r, 'rgba(' + color + ',' + contrast * opacity + ')');
      texture.fillStyle = wash;
      texture.fillRect(0, 0, size, size);
      const pattern = ctx.createPattern(tile, 'repeat');
      if (!pattern) return;
      this.tile = { key, pattern, size };
    }
    const physicalPitch = pitch * dpr;
    const offset = (value: number) =>
      ((((value * camera.z * dpr) % physicalPitch) + physicalPitch) % physicalPitch) -
      physicalPitch / 2;
    const scale = physicalPitch / this.tile.size;
    this.tile.pattern.setTransform(
      new DOMMatrix([scale, 0, 0, scale, offset(camera.x), offset(camera.y)]),
    );
    ctx.fillStyle = this.tile.pattern;
    ctx.fillRect(0, 0, w * dpr, h * dpr);
  }
}
