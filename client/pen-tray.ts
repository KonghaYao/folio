import type { CanvasTool } from './canvas';
import './pen-tray.css';

type Instrument = 'select' | 'pen' | 'pencil' | 'marker' | 'eraser' | 'lasso' | 'ruler';

const instrumentNames: Record<Instrument, string> = {
  select: '选择',
  pen: '钢笔',
  pencil: '铅笔',
  marker: '荧光笔',
  eraser: '橡皮擦',
  lasso: '套索选择',
  ruler: '直尺',
};

// Physical instrument silhouettes are drawn in one local coordinate system.
// Top/middle/bottom highlights model round painted bodies independently of the nib.
function instrumentArt(tool: Instrument): string {
  const white = 'url(#tray-white)',
    lead = 'url(#tray-lead)',
    sleeve = 'url(#tray-sleeve)';
  const art: Record<Instrument, string> = {
    select: `<g opacity=".72" filter="url(#tray-soft)"><path d="M-3 9 23 10.6 30 14.5 28 22.6 1 25.1H-3Z" fill="${white}"/><path d="m18 11 5-3 4 5-8 5 2-5z" fill="${sleeve}"/><path d="M25 11.4 35 11.3 36.7 21.7 25 22.4z" fill="${white}"/><path d="M35 11q14-.2 25.5 4.2l.5 1.5q-7.4 2.4-25 5z" fill="${sleeve}"/></g>`,
    pen: `<path d="M-3 7.6H52q3 0 6 1l19.4 5.8v4.9L58 24.8q-3 .8-6 .8H-3Z" fill="${white}"/><path d="M46.7 7.7h2.9v17.7h-2.9z" fill="${lead}"/><path d="M77.5 14.4q4.6.8 7.2 2.1.4.3.1.7-3.1 1.6-7.3 2.1z" fill="var(--pen-tip,url(#tray-lead))"/><path d="M51 8.1q3.8.1 6.1.9L75 14.4" fill="none" stroke="#d5d5d5" stroke-width=".36" opacity=".7"/>`,
    pencil: `<path d="M-3 7.7h28q2 .2 4 1l3 1.2v13.9l-4.9 1.7H-3Z" fill="${white}"/><path d="M16.5 7.6h1.8v17.9h-1.8z" fill="${lead}"/><path d="M30 9.3h9q3 .2 5.9 1.2v12.6l-5.4 1.1H30z" fill="${white}"/><path d="M30 9.5h1v14.6h-1z" fill="${sleeve}"/><path d="M44.8 11.1h5.4l.8 11.2h-6.2z" fill="${white}"/><path d="M44.8 11h.65v11.4h-.65z" fill="${sleeve}"/><path d="M51 15.2h6.6v3.4H51z" fill="${sleeve}"/><path d="M57 16.1h3.2v1.6H57z" fill="var(--pencil-tip,url(#tray-lead))"/>`,
    marker: `<path d="M-4 7.8H28q3 .05 7.8 2.3l4.1 1.1h10.9v10.9H40.1l-4.4 1.1q-4.5 2.1-7.9 2.1H-4z" fill="${white}"/><path d="M19 7.8h7.6v17.5H19z" fill="var(--marker-tip,url(#tray-blue))"/><path d="M52 12.1h4.4q1 0 1.5 1l3.2 6.9q.4.9-.65 1h-8.5z" fill="var(--marker-tip,#2786f4)"/><text x="6.8" y="16.4" transform="rotate(-90 6.8 16.4)" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="600" font-size="6.1" fill="#a3a3a3">80</text>`,
    eraser: `<path d="M-3 7.8h48.3v17.4H-3z" fill="${white}"/><path d="M31 8h.5v17H31z" fill="#b5b5b5" opacity=".26"/><path d="m36.4 14.1 5.2 5.2m0-5.2-5.2 5.2" stroke="#ee8f90" stroke-width="1.7" stroke-linecap="round"/><path d="M46 8h10.2q3.7.1 4.2 3.7.7 4.2.15 9.5-.5 3.9-4 4H46z" fill="url(#tray-red)"/><path d="M46.2 8.4v16.5" stroke="#d4a0a0" stroke-width=".65"/>`,
    lasso: `<path d="M-3 8.2h33.5l9 2.7v11.5l-9 2.4H-3Z" fill="${white}"/><path d="M30 8.2q1.4-.4 3.6.2l27.1 7.5q1.2.4 0 .9L32.1 24.7q-1.1.4-2.1.15z" fill="url(#tray-stripes)"/><path d="M30 8.2 61 16l-31 8.85z" fill="url(#tray-lasso-shade)"/>`,
    ruler: `<path d="M-1 2.2h60.4q1.3 0 1.3 1.3v21H-1z" fill="url(#tray-ruler)"/><path d="M-.5 2.3h60.8l.8 1.2v19.7" fill="none" stroke="#b8b8b8" opacity=".7" stroke-width=".7"/><g stroke="#838383" stroke-width=".95" stroke-linecap="round">${Array.from({ length: 16 }, (_, i) => `<path d="M${i * 4 - 0.6} 4.1v${i % 5 === 0 ? 7.4 : 2.3}"/>`).join('')}</g>`,
  };
  return `<svg class="tray-instrument-art" viewBox="0 0 94 34" width="94" height="34" aria-hidden="true"><g>${art[tool]}</g></svg>`;
}

function paintDefinitions(): string {
  return `<svg class="tray-paints" width="0" height="0" aria-hidden="true"><defs>
    <linearGradient id="tray-white" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="#d6d6d6"/><stop offset=".13" stop-color="#dfdfdf"/><stop offset=".41" stop-color="#efefef"/><stop offset=".68" stop-color="#f5f5f5"/><stop offset=".86" stop-color="#f2f2f2"/><stop offset="1" stop-color="#d9d9d9"/></linearGradient>
    <linearGradient id="tray-sleeve" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#a8a8a8"/><stop offset=".2" stop-color="#d6d6d6"/><stop offset=".69" stop-color="#f5f5f5"/><stop offset="1" stop-color="#b1b1b1"/></linearGradient>
    <linearGradient id="tray-lead" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#373737"/><stop offset=".34" stop-color="#121212"/><stop offset=".7" stop-color="#212121"/><stop offset="1" stop-color="#474747"/></linearGradient>
    <linearGradient id="tray-blue" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#2075d7"/><stop offset=".28" stop-color="#2b85ed"/><stop offset=".62" stop-color="#4d9df7"/><stop offset="1" stop-color="#2e8af0"/></linearGradient>
    <linearGradient id="tray-red" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#da7979"/><stop offset=".19" stop-color="#eb8787"/><stop offset=".52" stop-color="#f19999"/><stop offset=".78" stop-color="#f59b9b"/><stop offset="1" stop-color="#e88081"/></linearGradient>
    <pattern id="tray-stripes" patternUnits="userSpaceOnUse" width="4.5" height="4.5" patternTransform="rotate(-42)"><path fill="#efefef" d="M0 0h4.5v4.5H0z"/><path fill="#bcbcbc" d="M0 0h1.8v4.5H0z"/></pattern>
    <linearGradient id="tray-lasso-shade" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#bbb" stop-opacity=".18"/><stop offset=".5" stop-color="white" stop-opacity=".09"/><stop offset="1" stop-color="#eee" stop-opacity=".4"/></linearGradient>
    <linearGradient id="tray-ruler" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#e8e8e8"/><stop offset=".12" stop-color="#f0f0f0"/><stop offset="1" stop-color="#f9f9f9"/></linearGradient>
    <filter id="tray-soft" x="-5%" y="-15%" width="115%" height="135%"><feGaussianBlur stdDeviation=".85"/></filter>
  </defs></svg>`;
}

const palette = [
  ['#ffd02d', '黄色'],
  ['#000000', '黑色'],
  ['#ff3047', '红色'],
  ['#1683ff', '蓝色'],
  ['custom', '自选颜色'],
  ['#50d663', '绿色'],
];

function toolCell(id: Instrument): string {
  const direct = ['lasso', 'ruler'].includes(id) ? `data-action="tray-${id}"` : `data-tool="${id}"`;
  return `<button class="tray-instrument" type="button" data-instrument="${id}" ${direct} aria-label="${instrumentNames[id]}" title="${instrumentNames[id]}" aria-pressed="false">${instrumentArt(id)}</button>`;
}

function symbol(id: 'undo' | 'redo' | 'more'): string {
  if (id === 'more')
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><circle cx="4.3" cy="12" r="2.1"/><circle cx="12" cy="12" r="2.1"/><circle cx="19.7" cy="12" r="2.1"/></g></svg>';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10.1 5.2-5.7 5.7 5.7 5.7M5 10.9h9a5.1 5.1 0 1 1 0 10.2h-2" transform="${id === 'redo' ? 'translate(24 -1.5) scale(-1 1)' : 'translate(0 -1.5)'}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function penTrayMarkup(): string {
  const buttons = (Object.keys(instrumentNames) as Instrument[]).map(toolCell).join('');
  const wells = palette
    .map(([value, label]) =>
      value === 'custom'
        ? `<label class="tray-well tray-spectrum" title="${label}"><input id="ink-color" type="color" value="#000000" aria-label="${label}"></label>`
        : `<button type="button" class="tray-well" data-color="${value}" aria-pressed="false" aria-label="${label}" title="${label}" style="--tray-color:${value}"></button>`,
    )
    .join('');
  return `${paintDefinitions()}<nav id="pen-tray" class="tool-rail" aria-label="绘图工具">
      <div class="tray-history">${(['undo', 'redo'] as const).map((a, i) => `<button class="tray-round" type="button" data-action="${a}" aria-label="${i ? '重做' : '撤销'}" title="${i ? '重做' : '撤销'}">${symbol(a)}</button>`).join('')}</div>
      <div class="tray-instruments">${buttons}</div><b class="tray-grip" aria-hidden="true"></b>
      <div class="tray-palette">${wells}</div>
      <button type="button" class="tray-round tray-more" data-action="tray-more" popovertarget="pen-tools-popover" aria-label="画笔选项" title="画笔选项">${symbol('more')}</button>
    </nav>
    <section id="pen-tools-popover" popover aria-label="画笔选项">
      <div id="ink-strip"><label for="ink-width">线宽 <output id="ink-width-value" for="ink-width">4 px</output></label><input id="ink-width" type="range" min="1" max="64" step="0.5" value="4" aria-label="线宽"></div>
      <button type="button" data-tool="hand" aria-pressed="false"><span aria-hidden="true">✥</span>平移</button>
      <button type="button" data-action="drawing-options"><span aria-hidden="true">⌇</span>绘图辅助</button>
      <label class="tray-size-choice">工具栏大小<select aria-label="工具栏大小" id="tray-size"><option value="auto">自动</option><option value="compact">紧凑</option><option value="large">大</option></select></label>
    </section>`;
}

export function syncPenTray(tool: CanvasTool, color: string, readOnly: boolean): void {
  const tray = document.getElementById('pen-tray');
  if (!tray) return;
  tray.dataset.activeTool = tool;
  if (tool === 'pen' || tool === 'pencil' || tool === 'marker') {
    tray.style.setProperty(
      '--' + tool + '-tip',
      color.toLowerCase() === '#000000' && tool !== 'marker' ? 'url(#tray-lead)' : color,
    );
  }
  for (const button of tray.querySelectorAll<HTMLButtonElement>('[data-color]')) {
    button.disabled = readOnly;
    button.setAttribute('aria-pressed', String(button.dataset.color === color.toLowerCase()));
  }
  for (const button of tray.querySelectorAll<HTMLButtonElement>('[data-instrument]'))
    button.disabled = readOnly;
  const picker = tray.querySelector<HTMLInputElement>('#ink-color');
  if (picker) picker.disabled = readOnly;
  const spectrum = tray.querySelector('.tray-spectrum');
  const custom = !palette.some(([value]) => value === color.toLowerCase());
  spectrum?.classList.toggle('is-selected', custom);
  if (custom) (spectrum as HTMLElement | null)?.style.setProperty('--custom-ink', color);
  const more = document.getElementById('pen-tools-popover');
  const slide = more?.querySelector<HTMLInputElement>('#ink-width');
  if (slide) slide.disabled = readOnly || !['pen', 'pencil', 'marker'].includes(tool);
  if (more && !more.dataset.bound) {
    more.dataset.bound = 'true';
    const size = more.querySelector<HTMLSelectElement>('#tray-size');
    const applySize = (value: string) => {
      if (!size) return;
      size.value = ['auto', 'compact', 'large'].includes(value) ? value : 'auto';
      tray.dataset.size = size.value;
    };
    try {
      applySize(localStorage.getItem('folio.tray.size') || 'auto');
    } catch {
      applySize('auto');
    }
    size?.addEventListener('change', () => {
      applySize(size.value);
      try {
        localStorage.setItem('folio.tray.size', size.value);
      } catch {
        /* Styling remains usable for this tab. */
      }
    });
    more.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('button')) more.hidePopover();
    });
  }
}
