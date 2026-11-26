import { icon } from './icons';

/** Native modal focus management, Escape support and focus restoration. */
export function modal(title: string, body: HTMLElement): HTMLDialogElement {
  const dialog = document.createElement('dialog');
  dialog.className = 'folio-dialog';
  dialog.setAttribute('aria-label', title);
  const head = document.createElement('header');
  const heading = document.createElement('h2');
  heading.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-button';
  close.setAttribute('aria-label', '关闭');
  close.innerHTML = icon('close', 18);
  close.onclick = () => dialog.close();
  head.append(heading, close);
  dialog.append(head, body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const { left, right, top, bottom } = dialog.getBoundingClientRect();
      if (
        event.clientX < left ||
        event.clientX > right ||
        event.clientY < top ||
        event.clientY > bottom
      )
        dialog.close();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

export function textPrompt(options: {
  title: string;
  inputLabel: string;
  value?: string;
  placeholder?: string;
  type?: 'text' | 'url';
  button: string;
  maxLength?: number;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const form = document.createElement('form');
    form.className = 'dialog-form';
    const label = document.createElement('label');
    label.textContent = options.inputLabel;
    const input = document.createElement('input');
    input.type = options.type ?? 'text';
    input.required = true;
    input.maxLength = options.maxLength ?? 256;
    input.placeholder = options.placeholder ?? '';
    input.value = options.value ?? '';
    label.append(input);
    const submit = document.createElement('button');
    submit.className = 'primary-action';
    submit.textContent = options.button;
    form.append(label, submit);
    let result: string | null = null;
    const dialog = modal(options.title, form);
    dialog.addEventListener('close', () => resolve(result), { once: true });
    form.onsubmit = (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        input.focus();
        return;
      }
      if (options.type === 'url' && !/^https?:\/\//i.test(value)) {
        input.setCustomValidity('请输入以 https:// 或 http:// 开头的网址。');
        input.reportValidity();
        return;
      }
      result = value;
      dialog.close();
    };
    input.oninput = () => input.setCustomValidity('');
    input.focus();
    if (input.value) input.select();
  });
}
