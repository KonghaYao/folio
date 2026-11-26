/** A consistent 24-unit icon set for editor commands. */
const glyphs = {
  chat: '<path d="M20.5 11.3a8.4 8.4 0 0 1-8.7 8.3 10.4 10.4 0 0 1-4-.8l-4.2 1.3 1.2-4.1a8 8 0 0 1-1.1-4.3 8.4 8.4 0 0 1 8.5-8.2 8.2 8.2 0 0 1 8.3 7.8Z"/><path d="M8.4 10h7.1m-7.1 3.4h4.6"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  back: '<path d="m15.4 4.8-7.2 7.2 7.2 7.2" />',
  forward: '<path d="m8.6 4.8 7.2 7.2-7.2 7.2" />',
  markup:
    '<circle cx="12" cy="12" r="10.15" stroke-width="1.4"/><circle cx="12" cy="12" r="8.25" fill="currentColor" stroke="none"/><path d="m6.6 19.6 4.2-12.4q.46-1.05.97 0l5.35 12.4-2.48.2-2.0-5.6h-2.3L8.9 19.8z" fill="white" stroke="none"/>',
  textBox:
    '<path d="M2.3 9.3V6.1a2.1 2.1 0 0 1 2.1-2.1h15.2a2.1 2.1 0 0 1 2.1 2.1v3.2M2.3 14.7v3.1a2.1 2.1 0 0 0 2.1 2.1h15.2a2.1 2.1 0 0 0 2.1-2.1v-3.1"/><path d="M2.2 11.5v.9m19.5-.9v.9" stroke-width="1.9"/><text x="12" y="16.9" text-anchor="middle" font-size="12.8" font-weight="600" font-family="sans-serif" fill="currentColor" stroke="none">字</text>',
  freeShape:
    '<circle cx="9.5" cy="9.8" r="7.2"/><rect x="9" y="9" width="12.9" height="12.2" rx="1.9" fill="var(--icon-paper,#fff)"/>',
  freeNote:
    '<rect x="3.2" y="3.7" width="17.6" height="16.6" rx="1.7"/><path d="M4.8 4.25h14.3q1 0 1 1v2.9h-16V5.25q0-1 1-1" fill="currentColor" stroke="none"/><path d="M7 11.8h10m-10 4h6.1" stroke-width="1.4"/>',
  freeTable:
    '<rect x="2.1" y="4.7" width="19.8" height="15.5" rx="1.9"/><path d="M2.8 10.1h18.4M2.8 14.9h18.4M11.7 5v14.9" stroke-width="1.45"/>',
  paperclip:
    '<path d="m20.2 11.7-8.6 9.1a5.5 5.5 0 0 1-8-7.5l10-10.5a3.8 3.8 0 0 1 5.5 5.2L9.8 18a1.95 1.95 0 0 1-2.8-2.7l8.5-9" stroke-width="1.8"/>',
  boardInfo:
    '<path d="M8.4 2.4h7.4M6.8 5.3h10.6" stroke-width="1.48"/><rect x="4.7" y="8.1" width="14.6" height="13.8" rx="2.2"/>',
  shareBox:
    '<path d="M8.8 7.8H6.4A1.7 1.7 0 0 0 4.7 9.5v10.2a1.7 1.7 0 0 0 1.7 1.7h11.2a1.7 1.7 0 0 0 1.7-1.7V9.5a1.7 1.7 0 0 0-1.7-1.7h-2.4M12 14V2.1m-3.7 3.7L12 2.1l3.7 3.7"/>',
  compose:
    '<path d="M13.5 4.5H6.9a3.3 3.3 0 0 0-3.3 3.3v9.3a3.3 3.3 0 0 0 3.3 3.3h9.3a3.3 3.3 0 0 0 3.3-3.3v-6.7M11.9 12.1l-2 3.1 3.3-1.4 8-8.5a1.2 1.2 0 0 0-1.7-1.7z" stroke-width="1.5"/>',
  sceneList:
    '<path d="M8.4 6h13.1M8.4 12h13.1M8.4 18h13.1"/><circle cx="3.1" cy="6" r="1.2" fill="currentColor"/><circle cx="3.1" cy="12" r="1.2" fill="currentColor"/><circle cx="3.1" cy="18" r="1.2" fill="currentColor"/>',
  sceneSave:
    '<rect x="1.6" y="3.9" width="20.8" height="16.2" rx="2.1"/><path d="m12 6.2 1.8 3.6 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" fill="currentColor" stroke="none"/>',
  connector:
    '<path d="M5.5 15.9a7.7 7.7 0 0 1 4.1-6.5m4.6 0a8.4 8.4 0 0 1 4.3 6.4" stroke-width="1.5"/><rect x="1.8" y="15.1" width="5.5" height="5.3" rx="1.1" fill="currentColor"/><rect x="16.9" y="15.1" width="5.3" height="5.3" rx="1.1" fill="currentColor"/><circle cx="12" cy="6.7" r="2.9" fill="currentColor"/>',
  gridBox:
    '<rect x="3.2" y="3.1" width="17.7" height="17.7" rx=".9"/><path d="M7.2 7.4h.1m4.6 0h.1m4.4 0h.1m-9.3 4.7h.1m4.6 0h.1m4.4 0h.1m-9.3 4.5h.1m4.6 0h.1m4.4 0h.1" stroke-width="1.75"/>',
  devices:
    '<rect x="2.8" y="4.5" width="15" height="11" rx="1.4"/><path d="M6 19h7m-3-3.5V19"/><rect x="15" y="9" width="6.5" height="11" rx="1.4" fill="var(--icon-paper,white)"/>',
  find: '<circle cx="10.3" cy="10.3" r="6.4"/><path d="m15.3 15.3 5.3 5.3"/>',
  format: '<path d="M3 17h9m-7 3 4-14 4 14m2-9 3-7 3 7m-5-2h4"/>',
  select: '<path d="m5 3 14 10-7 1-3.5 6z"/>',
  hand: '<path d="M8 11.5V6.2a1.5 1.5 0 0 1 3 0V10m0-1V4.8a1.5 1.5 0 0 1 3 0v5.3m0-.7V6a1.5 1.5 0 0 1 3 0v5.2m0-1.5V8.5a1.5 1.5 0 1 1 3 0V14c0 3.8-2.3 6.8-6.2 6.8H13c-2.7 0-4.4-1.6-6-4.1l-2.7-4.2a1.7 1.7 0 0 1 2.5-2.1l2.4 2.3"/>',
  pen: '<path d="m5 19 2-7 8.9-8.9 4 4L11 16z"/><path d="m7 12 4 4m2.5-10.5 4 4M5 19l-1 1"/>',
  pencil:
    '<path d="m4 20 1.5-6L16 3.5a1.5 1.5 0 0 1 2 0l2.5 2.5a1.5 1.5 0 0 1 0 2L10 18.5z"/><path d="m5.5 14 4.5 4.5m4-13 4.5 4.5m-11 5 8.6-8.6"/>',
  marker:
    '<path d="m5 15 9.8-11a1.8 1.8 0 0 1 2.5 0L20 6.4a1.7 1.7 0 0 1 .1 2.4L10 19z"/><path d="m6.3 16.2-3.1 4.2 4-.3 2-2.3m2.5-10.1 5.6 5"/>',
  eraser:
    '<path d="m3.8 14.2 9-10a1.8 1.8 0 0 1 2.5-.1l4.7 4.2a1.8 1.8 0 0 1 .1 2.5l-8 8.8H8.5L4 15.8a1.2 1.2 0 0 1-.2-1.6z"/><path d="m8.6 8.7 7.4 6.6m-4.5 4.4h9"/>',
  shape:
    '<rect x="3.5" y="3.5" width="12" height="12" rx="2"/><circle cx="15.5" cy="15.5" r="5.2" fill="var(--icon-paper,white)"/>',
  text: '<path d="M3.8 6.4V4.7h16.4v1.7M12 5v14m-3.6.3h7.2"/>',
  note: '<path d="M5 3.8h14a1.3 1.3 0 0 1 1.3 1.3V14L14 20.3H5A1.3 1.3 0 0 1 3.7 19V5A1.3 1.3 0 0 1 5 3.8z"/><path d="M14 20v-5a1.2 1.2 0 0 1 1.2-1.2h5M8 9h7"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
  minus: '<path d="M5 12h14"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  undo: '<path d="m8.5 5-5 4.5 5 4.5M4.5 9.5H14a5.3 5.3 0 1 1 0 10.5"/>',
  redo: '<path d="m15.5 5 5 4.5-5 4.5m4-4.5H10a5.3 5.3 0 1 0 0 10.5"/>',
  share:
    '<circle cx="9.5" cy="8" r="3.1"/><path d="M3.6 19v-1a5.9 5.9 0 0 1 11.8 0v1M18.4 8.5v6m-3-3h6"/>',
  scenes: '<rect x="3.5" y="5.2" width="17" height="13.5" rx="2"/><path d="m10 9 4 3-4 3z"/>',
  grid: '<circle cx="6" cy="6" r="1" fill="currentColor"/><circle cx="12" cy="6" r="1" fill="currentColor"/><circle cx="18" cy="6" r="1" fill="currentColor"/><circle cx="6" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="18" cy="12" r="1" fill="currentColor"/><circle cx="6" cy="18" r="1" fill="currentColor"/><circle cx="12" cy="18" r="1" fill="currentColor"/><circle cx="18" cy="18" r="1" fill="currentColor"/>',
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/>',
  library: '<path d="M3.5 5.5v13M7.5 4.5v14m4-13v13m3-12 3-1 3 12-3 1z"/>',
  fit: '<path d="M8.5 4H5a1 1 0 0 0-1 1v3.5M15.5 4H19a1 1 0 0 1 1 1v3.5M20 15.5V19a1 1 0 0 1-1 1h-3.5M8.5 20H5a1 1 0 0 1-1-1v-3.5"/>',
  file: '<path d="M6 3.7h8.5l4 4V20H6z"/><path d="M14.5 3.7v4.5H19"/>',
  link: '<path d="m10 13.8 4-4m-6 1.9 3.8-3.8a3.5 3.5 0 0 1 4.9 4.9l-1.4 1.4m.7-5.9-3.8 3.8a3.5 3.5 0 0 1-4.9-4.9l1.4-1.4" transform="translate(-1 1) scale(1.04)"/>',
  attach:
    '<path d="m8.5 13.5 6.3-6.3a2 2 0 0 1 2.8 2.8l-8.2 8.2a3.5 3.5 0 1 1-5-5l8.8-8.8a4.6 4.6 0 0 1 6.5 6.5l-8.1 8.1"/>',
  arrow: '<path d="M4 19 19 4m-7 0h7v7"/>',
  line: '<path d="M4 20 20 4"/>',
  laser: '<path d="m4 20 9.8-9.8 2 2L6 22zM15 3v3m5 1-2 2m4 3h-3M10.5 5.5l2 2"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  diagram:
    '<rect x="8" y="3" width="8" height="5" rx="1"/><path d="M12 8v4M6 15v-3h12v3"/><rect x="3" y="15" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/>',
  export: '<path d="M12 15V3m-4 4 4-4 4 4M4.5 13v6a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-6"/>',
  import: '<path d="M12 3v12m-4-4 4 4 4-4M4.5 14v5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-5"/>',
  inspect:
    '<path d="M3 7h8m5 0h5M3 17h3m5 0h10"/><circle cx="13.5" cy="7" r="2.5"/><circle cx="8.5" cy="17" r="2.5"/>',
  duplicate:
    '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  trash: '<path d="M4 6h16m-3 0-.6 14H7.6L7 6m3 0V3h4v3m-4 4v6m4-6v6"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.2a2.5 2.5 0 1 1 3.8 2.2c-1.2.6-1.3 1-1.3 2.3m0 3h.01"/>',
  close: '<path d="m6 6 12 12m0-12L6 18"/>',
  cloud:
    '<path d="M6.5 17.5a4.1 4.1 0 1 1 .4-8.2 5.7 5.7 0 0 1 10.8-1.1 4.7 4.7 0 0 1 0 9.3"/><path d="m9 15.8 2.2 2.2 4-4"/>',
  layers: '<path d="m12 4 9 5-9 5-9-5 9-5zm-8.5 9 8.5 4.7 8.5-4.7m-17 4 8.5 4.7 8.5-4.7"/>',
  rectangle: '<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
  triangle: '<path d="m12 3.5 9 16h-18z"/>',
  diamond: '<path d="m12 3 9 9-9 9-9-9z"/>',
  hexagon: '<path d="m7 4 10 0 5 8-5 8H7l-5-8z"/>',
  star: '<path d="m12 2.5 3 6.2 6.8 1-4.9 4.8 1.1 6.8-6-3.2-6 3.2 1.1-6.8-4.9-4.8 6.8-1z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.5v6l4 2"/>',
} as const;

export type IconName = keyof typeof glyphs;

export function icon(name: IconName, size = 20): string {
  return `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${glyphs[name]}</svg>`;
}
