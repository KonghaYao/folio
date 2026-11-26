import type { createBoardCanvas } from '../canvas';
import type { Board } from '../api';
import { getChatHistory, runChat, type ChatMessage } from '../chat-transport';
import { icon } from '../icons';
import { currentCacheScope } from '../offline';
import { configureChat, readSettings } from './settings';
import './chat.css';

type Canvas = ReturnType<typeof createBoardCanvas>;
type CanvasBridge = Awaited<ReturnType<typeof import('../canvas-mcp').createCanvasMcp>>;
const toolLabels: Record<string, string> = {
  canvas_read: '读取画布',
  canvas_create: '添加对象',
  canvas_update: '更新对象',
  canvas_delete: '删除对象',
  canvas_select: '选择对象',
  canvas_view: '调整视图',
};

function explainError(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    provider_error: '模型服务返回错误，请检查服务地址、模型和密钥。',
    provider_auth: '模型服务拒绝了密钥，请打开模型设置检查。',
    provider_endpoint: '无法使用此模型地址，请检查端点和 Folio 服务的地址设置。',
    chat_busy: '此画板的对话正在另一台设备上进行，请稍后再试。',
    provider_rate_limit: '请求已达模型服务的频率限制，请稍后再试。',
    invalid_settings: '模型设置格式无效，请检查所填的模型、地址和密钥。',
    permission_denied: '你的画板权限不足。',
    chat_cancelled: '对话已停止。',
    turn_expired: '本轮对话已超时，请重试。',
    canvas_error: '助手未能完成画布操作，请确认画板仍可访问。',
    agent_error: 'Peri 暂时无法完成此请求，请重试。',
    output_limit: '本轮输出达到上限，请缩小请求范围后重试。',
    turn_timeout: '模型响应超时，请重试。',
    inactive_workspace: '当前工作区已变更，请重新打开画板。',
    board_not_found: '你已无法访问此画板。',
    read_only: '当前画板仅可查看。',
  };
  return messages[code] ?? '未能完成对话。请检查连接、模型设置和 Folio 服务状态。';
}

export function mountBoardChat(board: Board, canvas: Canvas, flush: () => Promise<void>) {
  const root = document.getElementById('app')!;
  const toggle = root.querySelector<HTMLButtonElement>('[data-testid="chat-open"]')!;
  const scope = currentCacheScope() ?? Symbol('unpaired-board');
  const panel = document.createElement('aside');
  panel.id = 'chat-panel';
  panel.className = 'chat-panel';
  panel.dataset.testid = 'chat-panel';
  panel.setAttribute('aria-label', '画板 Chat');
  panel.hidden = true;
  panel.innerHTML = `
    <header class="chat-heading">${icon('chat', 21)}
      <div><h2>画板 Chat</h2><p class="chat-model-label"></p></div>
      <button type="button" data-testid="chat-settings" aria-label="模型设置" title="模型设置">${icon('inspect', 18)}</button>
      <button type="button" data-testid="chat-close" aria-label="关闭 Chat" title="关闭 Chat">${icon('close', 18)}</button>
    </header>
    <div class="chat-log" role="log" aria-label="对话记录" aria-live="polite" aria-relevant="additions" tabindex="0"></div>
    <footer class="chat-footer">
      <p class="chat-feedback" data-testid="chat-status" role="status"></p>
      <p class="chat-feedback" data-testid="chat-error" role="alert"></p>
      <form class="chat-composer">
        <textarea rows="2" maxlength="12000" placeholder="向画板提问，或描述要做的修改…" aria-label="消息" data-testid="chat-input"></textarea>
        <button type="submit" data-testid="chat-send" aria-label="发送消息" title="发送 (Enter)">${icon('send', 19)}</button>
        <button type="button" data-testid="chat-stop" aria-label="停止生成" title="停止生成" hidden>${icon('stop', 17)}</button>
      </form>
    </footer>`;
  root.append(panel);
  const get = <T extends HTMLElement>(id: string) =>
    panel.querySelector<T>(`[data-testid="chat-${id}"]`)!;
  const status = get('status'),
    error = get('error'),
    input = get<HTMLTextAreaElement>('input');
  const send = get<HTMLButtonElement>('send'),
    stop = get<HTMLButtonElement>('stop');
  const settings = get<HTMLButtonElement>('settings');
  const log = panel.querySelector<HTMLElement>('.chat-log')!;
  const form = panel.querySelector('form')!;
  const lifetime = new AbortController();
  let destroyed = false;
  let active: AbortController | undefined;
  let dialog: HTMLDialogElement | undefined;
  let revision = 0;
  let committed: ChatMessage[] = [];
  let historyFlight: Promise<void> | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  function syncControls() {
    const profile = readSettings(scope);
    panel.querySelector('.chat-model-label')!.textContent = profile.model || '尚未配置模型';
    log.setAttribute('aria-busy', String(!!active));
    settings.disabled = !!active;
    send.hidden = !!active;
    send.disabled = !input.value.trim();
    stop.hidden = !active;
  }
  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight <= 36;
  }
  function appendMessage(role: ChatMessage['role'], content: string) {
    log.querySelector('.chat-empty')?.remove();
    const item = document.createElement('article');
    item.className = 'chat-message';
    item.dataset.role = role;
    const label = document.createElement('small');
    label.textContent = role === 'user' ? '你' : '画板助手';
    const body = document.createElement('p');
    body.textContent = content;
    item.append(label, body);
    log.append(item);
    return body;
  }
  function showHistory(messages: ChatMessage[]) {
    const stick = nearBottom();
    log.replaceChildren();
    for (const { role, content } of messages) appendMessage(role, content);
    if (!messages.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent =
        board.role === 'viewer'
          ? '可以询问助手这张画板里有什么。当前画板仅可查看。'
          : '可以请助手整理选中的内容，或在画布上绘制新的图形。';
      log.append(empty);
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }
  function refreshHistory() {
    if (historyFlight || active || destroyed || panel.hidden || document.hidden) return;
    const at = revision;
    historyFlight = getChatHistory(
      board.id,
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(8000)]),
    )
      .then((messages) => {
        if (destroyed || at !== revision || active) return;
        if (status.textContent === '对话记录暂时无法同步。') status.textContent = '';
        if (JSON.stringify(messages) !== JSON.stringify(committed)) {
          committed = messages;
          showHistory(messages);
        }
      })
      .catch(() => {
        if (!destroyed && at === revision && !active && !error.textContent)
          status.textContent = '对话记录暂时无法同步。';
      })
      .finally(() => {
        historyFlight = undefined;
      });
  }
  function openSettings() {
    if (active || destroyed || dialog?.open) return;
    dialog = configureChat(scope, () => {
      revision++;
      syncControls();
      status.textContent = '模型设置已保存。';
      error.textContent = '';
      input.focus();
    });
  }
  function cancel() {
    if (active) {
      status.textContent = '正在停止…';
      active.abort();
    }
  }
  async function submit() {
    const prompt = input.value.trim();
    if (active || !prompt || destroyed) return;
    const profile = readSettings(scope);
    if (!profile.model || !profile.apiKey) {
      openSettings();
      return;
    }
    const version = revision;
    await historyFlight;
    if (
      destroyed ||
      version !== revision ||
      active ||
      panel.hidden ||
      input.value.trim() !== prompt
    )
      return;
    const controller = new AbortController();
    active = controller;
    revision++;
    input.value = '';
    syncControls();
    error.textContent = '';
    status.textContent = '正在连接模型…';
    const promptBody = appendMessage('user', prompt);
    log.scrollTop = log.scrollHeight;
    let bridge: CanvasBridge | undefined;
    const closeBridge = () => {
      void bridge?.close().catch(() => {});
    };
    let body: HTMLElement | undefined;
    let text = '';
    const runningTools = new Map<string, HTMLElement>();
    try {
      const { createCanvasMcp } = await import('../canvas-mcp');
      controller.signal.throwIfAborted();
      bridge = await createCanvasMcp({
        boardId: board.id,
        canvas,
        flush,
        isActive: () => !destroyed && active === controller && !controller.signal.aborted,
      });
      controller.signal.throwIfAborted();
      controller.signal.addEventListener('abort', closeBridge, { once: true });
      await runChat({
        boardId: board.id,
        settings: profile,
        prompt,
        signal: controller.signal,
        exchange: bridge.exchange,
        onEvent(event) {
          if (destroyed || controller.signal.aborted) return;
          const stick = nearBottom();
          if (event.type === 'text') {
            if (!body) body = appendMessage('assistant', '');
            body.append(document.createTextNode(event.text));
            text += event.text;
            status.textContent = '正在回复…';
          } else if (event.type === 'tool') {
            const label = toolLabels[event.name] ?? '操作画布';
            let chip = runningTools.get(event.name);
            if (event.phase === 'start' || !chip) {
              chip = document.createElement('small');
              chip.className = 'chat-activity';
              log.append(chip);
              runningTools.set(event.name, chip);
            }
            chip.textContent =
              label + { start: '中…', done: ' · 已完成', error: ' · 未完成' }[event.phase];
            if (event.phase !== 'start') runningTools.delete(event.name);
            status.textContent = '正在使用画布工具…';
            body = undefined;
          }
          if (stick) log.scrollTop = log.scrollHeight;
        },
      });
      controller.signal.throwIfAborted();
      committed = [
        ...committed,
        { role: 'user', content: prompt },
        { role: 'assistant', content: text },
      ];
      status.textContent = '回复已完成。';
    } catch (cause) {
      if (destroyed) return;
      if (controller.signal.aborted) status.textContent = '已停止生成。';
      else {
        error.textContent = explainError(cause);
        status.textContent = '';
      }
      const label = promptBody.previousElementSibling;
      if (label) label.textContent = controller.signal.aborted ? '你 · 已停止' : '你 · 本轮未完成';
      if (!input.value) input.value = prompt;
    } finally {
      controller.signal.removeEventListener('abort', closeBridge);
      if (bridge) await bridge.close().catch(() => {});
      if (active === controller) active = undefined;
      if (!destroyed) {
        syncControls();
        refreshHistory();
      }
    }
  }
  function setOpen(open: boolean) {
    if (destroyed) return;
    root.toggleAttribute('data-chat-open', open);
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    clearInterval(refreshTimer);
    if (open) {
      syncControls();
      input.focus({ preventScroll: true });
      refreshHistory();
      refreshTimer = setInterval(refreshHistory, 6000);
    } else {
      revision++;
      cancel();
      toggle.focus({ preventScroll: true });
    }
  }
  input.oninput = () => {
    send.disabled = !input.value.trim();
  };
  settings.onclick = openSettings;
  get('close').onclick = () => setOpen(false);
  stop.onclick = cancel;
  form.onsubmit = (event) => {
    event.preventDefault();
    void submit();
  };
  panel.onkeydown = (event) => {
    event.stopPropagation();
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
    if (event.target === input && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  };
  document.addEventListener('visibilitychange', refreshHistory);
  window.addEventListener('focus', refreshHistory);
  syncControls();
  showHistory([]);
  return {
    toggle: () => setOpen(panel.hidden),
    cancel,
    destroy() {
      destroyed = true;
      lifetime.abort();
      cancel();
      clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', refreshHistory);
      window.removeEventListener('focus', refreshHistory);
      dialog?.close();
      root.removeAttribute('data-chat-open');
      toggle.setAttribute('aria-expanded', 'false');
      panel.remove();
    },
  };
}
