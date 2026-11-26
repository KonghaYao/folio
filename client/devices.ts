import { clearOfflineCache } from './offline';
import './objects.css';

interface Workspace {
  id: string;
  boardCount: number;
}
interface LinkedDevice {
  id: string;
  name: string;
  current: boolean;
  lastSeen: number;
}
async function device<T>(
  resource: string,
  body?: object,
  method: 'GET' | 'POST' | 'DELETE' = body ? 'POST' : 'GET',
): Promise<T> {
  const response = await fetch('/api/devices/' + resource, {
    method,
    cache: 'no-store',
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    if (resource === 'claim' && [403, 404, 410].includes(response.status))
      throw new Error('配对链接已使用、失效或过期。请在原设备生成新链接。');
    if (method === 'DELETE' && response.status === 409) throw new Error('当前设备不能从这里断开。');
    if (method === 'DELETE' && response.status === 404)
      throw new Error('该设备已断开，请重新打开设备菜单。');
    throw new Error('暂时无法连接同步服务，请检查网络。');
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
function node<K extends keyof HTMLElementTagNameMap>(name: K, value: string) {
  const out = document.createElement(name);
  out.textContent = value;
  return out;
}
function panel(title: string) {
  const view = node('dialog', '');
  view.className = 'object-dialog device-panel';
  view.setAttribute('aria-label', title);
  const head = node('header', ''),
    exit = node('button', '关闭');
  exit.onclick = () => view.close();
  head.append(node('h2', title), exit);
  view.append(head);
  view.onclose = () => view.remove();
  view.onkeydown = (e) => e.stopPropagation();
  document.body.append(view);
  view.showModal();
  return view;
}
async function clearCachedIdentity() {
  // Reload other tabs before their next save under the new principal.
  localStorage.setItem('folio-workspace-switch', String(Date.now()));
  window.dispatchEvent(new Event('folio-workspace-switch'));
  await clearOfflineCache();
}
window.addEventListener('storage', (evt) => {
  if (evt.key === 'folio-workspace-switch') location.reload();
});
export async function consumeDeviceLink(): Promise<boolean> {
  const token = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (!token) return false;
  const view = panel('连接到已有工作区');
  view.append(
    node(
      'p',
      '继续后，本设备可以访问原设备工作区内的全部画板和文件夹。原有工作区可以在设备菜单中切换。',
    ),
  );
  const error = node('p', ''),
    confirm = node('button', '连接此设备');
  confirm.className = 'primary-action';
  view.append(error, confirm);
  return new Promise((resolve) => {
    let paired = false;
    view.addEventListener(
      'close',
      () => {
        history.replaceState(null, '', location.pathname);
        resolve(paired);
      },
      { once: true },
    );
    confirm.onclick = async () => {
      confirm.disabled = true;
      try {
        await device('claim', { token });
        await clearCachedIdentity();
        paired = true;
        view.close();
      } catch (err) {
        error.textContent = (err as Error).message;
        confirm.disabled = false;
      }
    };
  });
}
function linkedDevices(view: HTMLDialogElement, feedback: HTMLElement) {
  const section = node('section', '');
  section.className = 'device-list';
  const rows = node('div', '');
  rows.dataset.testid = 'linked-devices';
  section.append(node('h3', '此工作区的设备'), rows);
  view.append(section);
  async function refresh() {
    try {
      const { devices } = await device<{ devices: LinkedDevice[] }>('linked');
      if (!view.open) return;
      rows.replaceChildren();
      for (const item of devices) {
        const row = node('div', '');
        row.className = 'trusted-device';
        row.dataset.current = String(item.current);
        const description = node('div', '');
        const title = item.name || '浏览器设备';
        description.append(node('strong', item.current ? title + ' · 当前设备' : title));
        const when = item.lastSeen
          ? new Date(item.lastSeen).toLocaleString('zh-CN', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '未知';
        description.append(node('small', '上次活动 ' + when + ' · ' + item.id.slice(-5)));
        row.append(description);
        if (!item.current) {
          const disconnect = node('button', '断开设备');
          disconnect.onclick = async () => {
            if (disconnect.dataset.confirm !== 'yes') {
              disconnect.dataset.confirm = 'yes';
              disconnect.textContent = '确认断开';
              feedback.textContent = '此设备将失去该工作区的在线访问权限，画板会保留。';
              return;
            }
            disconnect.disabled = true;
            try {
              await device<void>('linked/' + encodeURIComponent(item.id), undefined, 'DELETE');
              feedback.textContent = '设备已断开。';
              await refresh();
            } catch (err) {
              feedback.textContent = (err as Error).message;
              disconnect.disabled = false;
            }
          };
          row.append(disconnect);
        }
        rows.append(row);
      }
    } catch (err) {
      rows.textContent = (err as Error).message;
    }
  }
  void refresh();
}

export async function showDevices() {
  const view = panel('同步我的设备');
  view.append(node('p', '在另一台设备的浏览器打开配对链接，即可同步整个工作区的画板和文件夹。'));
  const generate = node('button', '生成一次性配对链接'),
    feedback = node('p', '');
  generate.className = 'primary-action';
  const result = node('section', '');
  view.append(generate, result, feedback);
  feedback.setAttribute('role', 'status');
  linkedDevices(view, feedback);
  generate.onclick = async () => {
    generate.disabled = true;
    try {
      const { token, expiresAt } = await device<{ token: string; expiresAt: number }>('pair', {});
      const input = node('input', '');
      input.readOnly = true;
      input.setAttribute('aria-label', '一次性设备配对链接');
      input.value = location.origin + '/#pair=' + encodeURIComponent(token);
      input.style.width = '100%';
      const copy = node('button', '复制配对链接');
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(input.value);
          feedback.textContent = '已复制';
        } catch {
          input.select();
          feedback.textContent = '请选择并复制链接。';
        }
      };
      result.replaceChildren(
        node(
          'p',
          '仅发送给自己的设备，链接在 ' +
            new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
            ' 到期。',
        ),
        input,
        copy,
      );
    } catch (err) {
      feedback.textContent = (err as Error).message;
    } finally {
      generate.disabled = false;
    }
  };
  try {
    const { active, workspaces } = await device<{ active: string; workspaces: Workspace[] }>(
      'workspaces',
    );
    if (workspaces.length < 2) return;
    view.append(node('h3', '本机已连接的工作区'));
    for (const space of workspaces) {
      const current = active === space.id;
      const name =
        (current ? '当前工作区' : '切换工作区') +
        ' · ' +
        space.boardCount +
        ' 个画板 · ' +
        space.id.slice(-5);
      const pick = node('button', name);
      pick.disabled = current;
      pick.onclick = async () => {
        try {
          await device('switch', { workspaceId: space.id });
          await clearCachedIdentity();
          location.assign('/');
        } catch (err) {
          feedback.textContent = (err as Error).message;
        }
      };
      view.append(pick);
    }
  } catch (err) {
    feedback.textContent = (err as Error).message;
  }
}
