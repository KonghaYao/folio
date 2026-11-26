import { modal } from './dialogs';
import { listInvitations, revokeInvitation, shareBoard } from './net';

export function openSharing(boardId: string) {
  const body = document.createElement('div');
  body.className = 'dialog-form';
  body.innerHTML = `<p>仅共享当前画板。选择持有邀请链接的人可以执行的操作。</p>
    <label>访问权限<select aria-label="访问权限"><option value="viewer">仅查看</option><option value="editor">可编辑</option></select></label>
    <button class="primary-action">生成邀请链接</button>
    <label class="share-result" hidden>邀请链接<input aria-label="邀请链接" readonly></label>
    <button class="secondary-action" hidden>复制链接</button>
    <details class="invitation-list"><summary>管理已发出的邀请</summary><div></div></details>
    <p class="share-feedback" role="status"></p>`;
  const role = body.querySelector('select')!;
  const generate = body.querySelector<HTMLButtonElement>('.primary-action')!;
  const result = body.querySelector<HTMLInputElement>('input')!;
  const copy = body.querySelector<HTMLButtonElement>('.secondary-action')!;
  const details = body.querySelector('details')!;
  const list = details.querySelector('div')!;
  const feedback = body.querySelector<HTMLElement>('.share-feedback')!;
  const dialog = modal('共享画板', body);
  const reset = () => {
    result.parentElement!.hidden = true;
    copy.hidden = true;
    result.value = '';
    feedback.textContent = '';
  };
  role.onchange = reset;
  let sequence = 0;
  async function showInvitations() {
    const seq = ++sequence;
    try {
      const invitations = await listInvitations(boardId);
      if (seq !== sequence || !dialog.open) return;
      list.replaceChildren();
      if (!invitations.length) {
        list.textContent = '没有有效的邀请。';
        return;
      }
      for (const invite of invitations) {
        const row = document.createElement('div'),
          label = document.createElement('div');
        row.className = 'invitation-row';
        const name = document.createElement('strong');
        name.textContent = invite.role === 'viewer' ? '仅查看' : '可编辑';
        const meta = document.createElement('small');
        const when = new Date(invite.createdAt).toLocaleString('zh-CN', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        meta.textContent = `${when} · 已加入 ${invite.joinedCount} 人`;
        label.append(name, meta);
        const revoke = document.createElement('button');
        revoke.className = 'secondary-action';
        revoke.textContent = '撤销邀请';
        revoke.onclick = async () => {
          if (revoke.dataset.confirm !== 'yes') {
            revoke.dataset.confirm = 'yes';
            revoke.textContent = '确认撤销';
            feedback.textContent = '通过此邀请获得的访问权限将被撤销。';
            return;
          }
          revoke.disabled = true;
          try {
            await revokeInvitation(boardId, invite.id);
            reset();
            feedback.textContent = '邀请及其授予的权限已撤销。';
            await showInvitations();
          } catch {
            revoke.disabled = false;
            feedback.textContent = '撤销失败，请检查连接后重试。';
          }
        };
        row.append(label, revoke);
        list.append(row);
      }
    } catch {
      if (seq === sequence) list.textContent = '读取邀请失败，请重新展开此列表。';
    }
  }
  details.ontoggle = () => {
    if (details.open) void showInvitations();
  };
  generate.onclick = async () => {
    reset();
    generate.disabled = true;
    role.disabled = true;
    try {
      const link = await shareBoard(boardId, role.value === 'editor' ? 'editor' : 'viewer');
      result.value = link;
      result.parentElement!.hidden = false;
      copy.hidden = false;
      result.focus();
      result.select();
      if (details.open) await showInvitations();
    } catch {
      feedback.textContent = '生成邀请失败，请检查连接与共享权限。';
    } finally {
      generate.disabled = false;
      role.disabled = false;
    }
  };
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(result.value);
      feedback.textContent = '链接已复制';
    } catch {
      result.focus();
      result.select();
      feedback.textContent = '链接已选中，请复制。';
    }
  };
}
