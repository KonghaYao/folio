import type { Bounds } from '@quickdrawjs/core';
import type { BoardCanvas } from './canvas';
import type { Role } from './net';
import type { Peer } from '../server/presence';
import './presence.css';

const accents = ['#3663a0', '#9b4c7b', '#487a43', '#aa5f33', '#7653a0', '#237e80'];
const roleLabels: Record<Role, string> = { owner: '所有者', editor: '编辑者', viewer: '查看者' };
const label = (p: Peer) => roleLabels[p.role] + ' ' + p.id.slice(0, 3).toUpperCase();
const color = (id: string) => accents[parseInt(id.slice(-4), 16) % accents.length];

/** Owns one tab session. Every pointer and rectangle is expressed in board coordinates. */
export function bindPresence(boardId: string, canvas: BoardCanvas, _role: Role): () => void {
  const { editor } = canvas,
    surface = editor.container;
  const workspace = surface.closest<HTMLElement>('.workspace')!;
  const tab = Array.from(crypto.getRandomValues(new Uint8Array(16)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');
  const path = '/api/boards/' + encodeURIComponent(boardId) + '/presence';
  const controller = new AbortController(),
    signal = controller.signal;
  const layer = document.createElement('div');
  layer.className = 'presence-layer';
  layer.setAttribute('aria-hidden', 'true');
  workspace.append(layer);
  const control = document.createElement('div');
  control.className = 'presence-control';
  control.hidden = true;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'presence-trigger';
  trigger.dataset.action = 'participants';
  trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'presence-list';
  menu.hidden = true;
  menu.setAttribute('role', 'group');
  menu.setAttribute('aria-label', '协作者');
  control.append(trigger, menu);
  workspace.querySelector('.document-state')!.prepend(control);
  let self = '',
    peers: Peer[] = [],
    following = '',
    menuSignature = '',
    disposed = false;
  let cursor: Peer['cursor'] = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    flight = false,
    dirty = true;
  let notBefore = 0,
    frame = 0;
  const markers = new Map<string, HTMLElement>();

  function draw() {
    if (disposed) return;
    frame = 0;
    const others = peers.filter((peer) => self && peer.id !== self);
    const followed = others.find((p) => p.id === following);
    if (!followed) following = '';
    const ids = new Set(others.filter((p) => p.cursor).map((p) => p.id));
    for (const [id, marker] of markers)
      if (!ids.has(id)) {
        marker.remove();
        markers.delete(id);
      }
    for (const p of others) {
      if (!p.cursor) continue;
      let marker = markers.get(p.id);
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'peer-cursor';
        marker.dataset.peer = p.id;
        const name = document.createElement('span');
        marker.append(name);
        layer.append(marker);
        markers.set(p.id, marker);
        marker.style.setProperty('--peer-color', color(p.id));
      }
      marker.firstElementChild!.textContent = label(p);
      const screen = editor.pageToScreen(p.cursor.x, p.cursor.y);
      marker.style.transform = `translate(${screen.x}px,${screen.y}px)`;
    }
    control.hidden = !others.length;
    trigger.textContent =
      following && followed ? '跟随中 · ' + label(followed) : '协作者 ' + others.length;
    trigger.setAttribute('aria-label', '协作者 ' + others.length);
    if (!others.length) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
    const signature = others.map((p) => p.id + p.role).join(',') + '/' + following;
    if (signature === menuSignature) return;
    menuSignature = signature;
    menu.replaceChildren();
    for (const p of others) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.follow = p.id;
      button.setAttribute('aria-pressed', String(p.id === following));
      button.style.setProperty('--peer-color', color(p.id));
      const dot = document.createElement('i'),
        name = document.createElement('span'),
        action = document.createElement('small');
      name.textContent = label(p);
      action.textContent = following === p.id ? '停止跟随' : '跟随视图';
      button.append(dot, name, action);
      menu.append(button);
    }
  }
  function redraw() {
    if (!frame && !disposed) frame = requestAnimationFrame(draw);
  }
  function moveTo(view: Bounds) {
    const { w, h } = editor.viewSize();
    const z = Math.min(w / view.w, h / view.h);
    if (!(z > 0)) return;
    const next = { z, x: w / (2 * z) - view.x - view.w / 2, y: h / (2 * z) - view.y - view.h / 2 };
    const old = editor.camera;
    if (
      Math.abs(next.z - old.z) > 1e-6 ||
      Math.abs(next.x - old.x) > 0.01 ||
      Math.abs(next.y - old.y) > 0.01
    )
      editor.setCamera(next);
  }
  function stopFollowing() {
    if (following) {
      following = '';
      redraw();
    }
  }
  function receive(event: Event) {
    const data = (event as CustomEvent<{ boardId: string; peers: Peer[] }>).detail;
    if (data.boardId !== boardId) return;
    peers = data.peers;
    const peer = peers.find((p) => p.id === following);
    if (peer) moveTo(peer.view);
    redraw();
  }
  function schedule() {
    dirty = true;
    if (!timer && !flight && !disposed && document.visibilityState !== 'hidden') {
      timer = setTimeout(
        () => {
          timer = undefined;
          void send();
        },
        Math.max(0, notBefore - performance.now()),
      );
    }
  }
  async function send() {
    if (disposed || flight || !dirty) return;
    dirty = false;
    flight = true;
    notBefore = performance.now() + 180;
    try {
      const result = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ tab, cursor, view: editor.viewportPageBounds() }),
      });
      if (result.ok) {
        self = (await result.json()).self;
        redraw();
      } else if (result.status === 429) notBefore = performance.now() + 1500;
    } catch {
      /* Offline ink edits and session recovery proceed independently. */
    } finally {
      flight = false;
      if (dirty) schedule();
    }
  }
  function onPointer(e: PointerEvent) {
    const box = surface.getBoundingClientRect();
    cursor = editor.screenToPage(e.clientX - box.left, e.clientY - box.top);
    schedule();
  }
  trigger.addEventListener(
    'click',
    () => {
      menu.hidden = !menu.hidden;
      trigger.setAttribute('aria-expanded', String(!menu.hidden));
    },
    { signal },
  );
  menu.addEventListener(
    'click',
    (event) => {
      const id = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-follow]')?.dataset
        .follow;
      const peer = peers.find((p) => p.id === id);
      if (!peer) return;
      following = id === following ? '' : peer.id;
      if (following) moveTo(peer.view);
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      redraw();
    },
    { signal },
  );
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!menu.hidden && !control.contains(event.target as Node)) {
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
      }
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && !menu.hidden) {
        menu.hidden = true;
        trigger.focus();
        trigger.setAttribute('aria-expanded', 'false');
      }
    },
    { signal },
  );
  surface.addEventListener('pointermove', onPointer, { signal });
  surface.addEventListener(
    'pointerleave',
    () => {
      cursor = null;
      schedule();
    },
    { signal },
  );
  surface.addEventListener('pointerdown', stopFollowing, { signal, capture: true });
  surface.addEventListener('wheel', stopFollowing, { signal, capture: true, passive: true });
  window.addEventListener('folio:presence', receive, { signal });
  window.addEventListener('online', schedule, { signal });
  const camera = editor.on('camera', () => {
    redraw();
    schedule();
  });
  const tick = setInterval(schedule, 7000);
  document.addEventListener('visibilitychange', schedule, { signal });
  const leave = () => {
    void fetch(path + '/' + tab, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  window.addEventListener('pagehide', leave, { signal });
  schedule();
  return () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    clearInterval(tick);
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    camera();
    control.remove();
    layer.remove();
    leave();
  };
}
