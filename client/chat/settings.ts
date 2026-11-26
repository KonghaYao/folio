import type { ChatSettings } from '../chat-transport';
import { modal } from '../dialogs';

type ChatProvider = ChatSettings['provider'];
type Scope = string | symbol;
type PublicSettings = Omit<ChatSettings, 'apiKey'>;
const endpoints: Record<ChatProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};
// Keys are bound to both the workspace and the exact selected endpoint in this tab.
const memory = new Map<Scope, ChatSettings>();

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function readSettings(scope: Scope): ChatSettings {
  // A change in another tab cannot redirect requests that carry this tab's key.
  const saved = memory.get(scope);
  if (saved) return { ...saved };
  const defaults: ChatSettings = {
    provider: 'openai',
    model: '',
    baseUrl: endpoints.openai,
    apiKey: '',
  };
  if (typeof scope !== 'string') return defaults;
  try {
    const raw = JSON.parse(localStorage.getItem('folio.chat.profile.' + scope) ?? 'null');
    if (
      raw &&
      (raw.provider === 'openai' || raw.provider === 'anthropic') &&
      typeof raw.model === 'string' &&
      typeof raw.baseUrl === 'string' &&
      validUrl(raw.baseUrl)
    )
      return { provider: raw.provider, model: raw.model, baseUrl: raw.baseUrl, apiKey: '' };
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return defaults;
}

export function configureChat(scope: Scope, onSave: () => void): HTMLDialogElement {
  const initial = readSettings(scope);
  const form = document.createElement('form');
  form.className = 'dialog-form';
  form.autocomplete = 'off';
  form.innerHTML = `
    <label>服务商（Provider）
      <select name="provider" data-testid="chat-provider">
        <option value="openai">OpenAI / OpenAI 兼容服务</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </label>
    <label>模型（Model）<input required name="model" data-testid="chat-model" placeholder="输入模型 ID" maxlength="256" spellcheck="false"></label>
    <label>服务地址（Base URL）<input required name="url" data-testid="chat-url" type="url" maxlength="2048" spellcheck="false"></label>
    <label>API Key<input required name="key" data-testid="chat-key" type="password" maxlength="4096" spellcheck="false" autocomplete="off"></label>
    <p class="chat-settings-note">密钥仅保留在当前标签页内存中。发送消息时，Folio 服务会用它访问所选模型；模型可按你的画板权限读取或编辑内容。</p>
    <button type="submit" class="primary-action" data-testid="chat-save">保存设置</button>`;
  const provider = form.elements.namedItem('provider') as HTMLSelectElement;
  const model = form.elements.namedItem('model') as HTMLInputElement;
  const url = form.elements.namedItem('url') as HTMLInputElement;
  const key = form.elements.namedItem('key') as HTMLInputElement;
  provider.value = initial.provider;
  model.value = initial.model;
  url.value = initial.baseUrl;
  key.value = initial.apiKey;
  provider.onchange = () => {
    url.value = endpoints[provider.value as ChatProvider];
    model.value = '';
    key.value = '';
    url.setCustomValidity('');
  };
  url.oninput = () => {
    url.setCustomValidity('');
    key.value = '';
  };
  model.oninput = () => model.setCustomValidity('');
  key.oninput = () => key.setCustomValidity('');
  const dialog = modal('模型设置', form);
  dialog.addEventListener(
    'close',
    () => {
      key.value = '';
    },
    { once: true },
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!validUrl(url.value.trim())) {
      url.setCustomValidity('请输入完整的 HTTP 或 HTTPS 服务地址，不含凭据、查询参数或片段。');
      url.reportValidity();
      return;
    }
    if (!model.value.trim() || !key.value.trim()) {
      const input = !model.value.trim() ? model : key;
      input.setCustomValidity('请填写此项。');
      input.reportValidity();
      return;
    }
    const prefs: PublicSettings = {
      provider: provider.value as ChatProvider,
      model: model.value.trim(),
      baseUrl: url.value.trim().replace(/\/+$/, ''),
    };
    memory.set(scope, { ...prefs, apiKey: key.value.trim() });
    try {
      if (typeof scope === 'string')
        localStorage.setItem('folio.chat.profile.' + scope, JSON.stringify(prefs));
    } catch {
      // Browsers with storage disabled still support a tab-local profile.
    }
    dialog.close();
    onSave();
  };
  if (initial.model && !initial.apiKey) key.focus();
  return dialog;
}
