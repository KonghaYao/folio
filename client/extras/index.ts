import type { Bounds } from '@quickdrawjs/core';
import { readAsset } from '../asset-cache';
import { showFind } from './find';
import { modal, textPrompt } from '../dialogs';
import { icon, type IconName } from '../icons';
import { makeArchive } from './archive';
import { importBoardFile } from './import-copy';
import { makePdf, makePng, renderFrame, type ExportEditor } from './render';
import {
  boardBounds,
  createScene,
  goToScene,
  isScene,
  saveScene,
  scenesOf,
  swapScenes,
  type Scene,
} from './scenes';
import './extras.css';

export interface ExtrasHost {
  boardId: string;
  editor: ExportEditor;
  title: () => string;
  flush: () => Promise<void>;
  openBoard: (id: string) => void | Promise<void>;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

function action(label: string, id: string, glyph?: IconName): HTMLButtonElement {
  const button = node('button', 'folio-extra-action');
  button.type = 'button';
  button.dataset.action = id;
  if (glyph) button.innerHTML = icon(glyph, 17);
  button.append(document.createTextNode(label));
  return button;
}

function message(): HTMLDivElement {
  const status = node('div', 'folio-extra-status');
  status.setAttribute('role', 'status');
  return status;
}

function saveFile(blob: Blob, title: string, extension: string): void {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download =
    (title
      .replace(/[\x00-\x1F\\/:*?"<>|]/g, '_')
      .trim()
      .slice(0, 150) || '画板') +
    '.' +
    extension;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function runAction(
  button: HTMLButtonElement,
  status: HTMLElement,
  callback: () => Promise<void>,
) {
  button.disabled = true;
  status.textContent = '正在处理…';
  try {
    await callback();
    status.textContent = '已完成';
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '操作失败';
  } finally {
    button.disabled = false;
  }
}

export function createBoardExtras(host: ExtrasHost) {
  const { editor } = host;
  const settleForExport = async () => {
    try {
      await host.flush();
    } catch (error) {
      if (navigator.onLine) throw error;
    }
  };
  let active: HTMLDialogElement | undefined;
  let find: ReturnType<typeof showFind> | undefined;
  function openFind() {
    if (document.querySelector('.folio-find')) {
      find?.focus();
      return;
    }
    find = showFind(editor);
  }
  const keydown = (event: KeyboardEvent) => {
    if (
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      event.shiftKey ||
      event.key.toLowerCase() !== 'f'
    )
      return;
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    openFind();
  };
  window.addEventListener('keydown', keydown, true);

  function show(title: string, body: HTMLElement, onClose?: () => void) {
    find?.close();
    active?.close();
    const dialog = modal(title, body);
    active = dialog;
    dialog.addEventListener(
      'close',
      () => {
        if (active === dialog) active = undefined;
        onClose?.();
      },
      { once: true },
    );
    return dialog;
  }

  function present(startId?: string) {
    let scenes = scenesOf(editor.store);
    if (!scenes.length) return;
    let id = startId ?? scenes[0].id;
    const view = node('div', 'folio-projector');
    const stage = node('div', 'folio-projector-stage');
    const screen = node('canvas');
    screen.setAttribute('aria-label', '当前场景');
    stage.append(screen);
    const controls = node('nav', 'folio-projector-controls');
    const previous = action('上一场', 'scene-prev');
    const next = action('下一场', 'scene-next');
    const exit = action('退出演示', 'scene-exit', 'close');
    const label = node('span');
    label.setAttribute('aria-live', 'polite');
    controls.append(previous, label, next, exit);
    view.append(stage, controls);
    let frame = 0;
    const redraw = () => {
      frame = 0;
      scenes = scenesOf(editor.store);
      if (!scenes.length) {
        dialog.close();
        return;
      }
      const index = Math.max(
        0,
        scenes.findIndex((s) => s.id === id),
      );
      const scene = scenes[index];
      id = scene.id;
      label.textContent = index + 1 + ' / ' + scenes.length + '　' + scene.title;
      previous.disabled = index === 0;
      next.disabled = index === scenes.length - 1;
      const rect = stage.getBoundingClientRect();
      const w = Math.max(1, Math.min(rect.width, (rect.height * scene.bounds.w) / scene.bounds.h));
      const h = Math.max(1, Math.min(rect.height, (rect.width * scene.bounds.h) / scene.bounds.w));
      const dpr = Math.min(window.devicePixelRatio || 1, 2, 4096 / Math.max(w, h));
      screen.width = Math.max(1, Math.round(w * dpr));
      screen.height = Math.max(1, Math.round(h * dpr));
      screen.style.width = w + 'px';
      screen.style.height = h + 'px';
      renderFrame(editor, screen, scene.bounds);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(redraw);
    };
    const step = (delta: number) => {
      const index = scenes.findIndex((s) => s.id === id);
      id = scenes[Math.max(0, Math.min(scenes.length - 1, index + delta))].id;
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    const offStore = editor.store.listen(schedule);
    const dialog = show('场景演示', view, () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      offStore();
    });
    dialog.classList.add('folio-projector-dialog');
    dialog.setAttribute('aria-label', '场景演示');
    exit.onclick = () => dialog.close();
    previous.onclick = () => step(-1);
    next.onclick = () => step(1);
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault();
        step(1);
      }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault();
        step(-1);
      }
    });
    observer.observe(stage);
    void editor.prepareImages().then(() => {
      if (dialog.open) schedule();
    });
    redraw();
    next.focus();
  }

  function openScenes() {
    const body = node('section', 'folio-extra-body');
    const list = node('div', 'folio-scene-list');
    const controls = node('div', 'folio-extra-bar');
    const add = action('保存当前视图', 'scene-add', 'plus');
    const play = action('演示', 'present', 'scenes');
    const status = message();
    if (!editor.readonly) controls.append(add);
    controls.append(play);
    body.append(controls, list, status);
    const off = editor.store.listen((diff) => {
      const changed = [
        ...Object.values(diff.added),
        ...Object.values(diff.removed),
        ...Object.values(diff.updated).flat(),
      ];
      if (changed.some(isScene)) refresh();
    });
    const dialog = show('场景', body, off);
    dialog.setAttribute('aria-label', '场景');
    add.onclick = () => {
      const nextNumber = scenesOf(editor.store).length + 1;
      createScene(editor, '场景 ' + nextNumber);
      status.textContent = '已保存当前视图';
    };
    play.onclick = () => present();

    function makeRow(scene: Scene, scenes: Scene[], index: number) {
      const row = node('div', 'folio-scene-row');
      const go = action(scene.title, 'scene-jump');
      go.title = '前往' + scene.title;
      go.onclick = () => {
        goToScene(editor, scene);
        dialog.close();
      };
      const more = node('details', 'folio-scene-options');
      const summary = node('summary');
      summary.textContent = '选项';
      summary.setAttribute('aria-label', scene.title + '选项');
      const options = node('div', 'folio-scene-commands');
      const command = (label: string, id: string, callback: () => void, disabled = false) => {
        const button = action(label, id);
        button.disabled = disabled;
        button.onclick = callback;
        options.append(button);
        return button;
      };
      if (!editor.readonly) {
        command('重命名', 'scene-rename', async () => {
          const name = await textPrompt({
            title: '重命名场景',
            inputLabel: '场景名称',
            value: scene.title,
            maxLength: 120,
            button: '保存',
          });
          const current: unknown = editor.store.get(scene.id);
          if (name && isScene(current)) saveScene(editor.store, { ...current, title: name });
        });
        command('使用当前视图', 'scene-reframe', () => {
          saveScene(editor.store, { ...scene, bounds: editor.viewportPageBounds() });
          status.textContent = '已更新场景范围';
        });
        command(
          '上移',
          'scene-up',
          () => swapScenes(editor.store, scene, scenes[index - 1]),
          index === 0,
        );
        command(
          '下移',
          'scene-down',
          () => swapScenes(editor.store, scene, scenes[index + 1]),
          index === scenes.length - 1,
        );
        command('移除', 'scene-remove', () => editor.store.remove([scene.id]));
      }
      const pdf = command(
        '下载此场景 PDF',
        'scene-pdf',
        () =>
          void runAction(pdf, status, async () => {
            await settleForExport();
            saveFile(await makePdf(editor, [scene.bounds], scene.title), scene.title, 'pdf');
          }),
      );
      more.append(summary, options);
      row.append(go, more);
      return row;
    }
    function refresh() {
      list.replaceChildren();
      const scenes = scenesOf(editor.store);
      play.disabled = scenes.length === 0;
      scenes.forEach((scene, index) => list.append(makeRow(scene, scenes, index)));
      if (!scenes.length) {
        const empty = node('p', 'folio-scene-empty');
        empty.textContent = editor.readonly
          ? '此画板没有保存的场景。'
          : '移动或缩放画板后，保存一个视图以便演示。';
        list.append(empty);
      }
    }
    refresh();
  }

  function openExport() {
    const body = node('div', 'folio-extra-body folio-export-list');
    const status = message();
    const option = (label: string, id: string, glyph: IconName, generate: () => Promise<void>) => {
      const button = action(label, id, glyph);
      button.onclick = () =>
        void runAction(button, status, async () => {
          await settleForExport();
          await generate();
        });
      body.append(button);
      return button;
    };
    option('整张画板 · PNG', 'export-png', 'export', async () => {
      saveFile(await makePng(editor, boardBounds(editor)), host.title(), 'png');
    });
    const pdfOption = (name: string, id: string, bounds: () => Bounds[]) =>
      option(name, id, 'file', async () => {
        const frames = bounds();
        if (!frames.length) throw new Error('请先保存一个场景');
        saveFile(await makePdf(editor, frames, host.title()), host.title(), 'pdf');
      });
    pdfOption('整张画板 · PDF', 'export-pdf', () => [boardBounds(editor)]);
    const pages = pdfOption('每个场景一页 · PDF', 'export-scenes-pdf', () =>
      scenesOf(editor.store).map((s) => s.bounds),
    );
    pages.disabled = !scenesOf(editor.store).length;
    option('可编辑副本 · Folio', 'export-archive', 'duplicate', async () => {
      saveFile(
        await makeArchive(editor.store, host.title(), host.boardId, readAsset),
        host.title(),
        'folio.json',
      );
    });
    body.append(status);
    const dialog = show('导出画板', body);
    dialog.setAttribute('aria-label', '导出画板');
  }

  function openImport() {
    const body = node('form', 'folio-extra-body folio-import-form');
    const label = node('label');
    label.textContent = 'Folio 画板副本';
    const input = node('input');
    input.type = 'file';
    input.accept = '.json,.folio,application/json';
    input.required = true;
    input.dataset.action = 'import-file';
    label.append(input);
    const submit = action('导入为新画板', 'import-submit', 'import');
    submit.type = 'submit';
    const status = message();
    body.append(label, submit, status);
    const dialog = show('导入画板', body);
    body.onsubmit = (event) => {
      event.preventDefault();
      const file = input.files?.[0];
      if (!file) return;
      void runAction(submit, status, async () => {
        await host.flush();
        const id = await importBoardFile(file);
        await host.openBoard(id);
        dialog.close();
      });
    };
  }

  return {
    openScenes,
    openExport,
    openImport,
    openFind,
    destroy() {
      window.removeEventListener('keydown', keydown, true);
      find?.close();
      active?.close();
    },
  };
}
