import { createBoard, deleteBoard, uploadAsset } from '../net';
import { chunkItems, parseArchive, relocate, archiveLimit } from './archive';

export async function importBoardFile(file: File): Promise<string> {
  if (file.size > archiveLimit) throw new Error('副本文件过大');
  const archive = parseArchive(await file.text());
  const board = await createBoard(
    (archive.title.trim().slice(0, 148) || '未命名画板') + '（副本）',
  );
  try {
    const urls = new Map<string, string>();
    for (const source of archive.resources) {
      const text = atob(source.base64);
      const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
      const saved = await uploadAsset(
        board.id,
        new File([bytes], source.name, { type: source.type }),
      );
      urls.set(source.path, saved.url);
    }
    let rev = board.rev;
    for (const put of chunkItems(relocate(archive.items, urls))) {
      const response = await fetch('/api/boards/' + encodeURIComponent(board.id) + '/ops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseRev: rev, opId: randomId(), put }),
      });
      if (!response.ok) throw new Error('副本保存失败（' + response.status + '）');
      rev = (await response.json()).rev;
    }
    return board.id;
  } catch (error) {
    await deleteBoard(board.id).catch(() => {});
    throw error;
  }
}

export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
