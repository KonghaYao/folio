import type { Database } from 'bun:sqlite';
import type { ChatMessage } from '../../shared/chat';

/** History is private to the workspace principal even on a shared board. */
export class ChatHistory {
  constructor(private readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_turns (
        seq INTEGER PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
        principal TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        reply TEXT NOT NULL,
        UNIQUE(board_id, principal, turn_id)
      );
      CREATE INDEX IF NOT EXISTS chat_turns_recent ON chat_turns(board_id, principal, seq);
    `);
  }

  messages(board: string, principal: string): ChatMessage[] {
    const rows = this.db
      .query<
        { prompt: string; reply: string },
        [string, string]
      >('SELECT prompt, reply FROM chat_turns WHERE board_id=? AND principal=? ORDER BY seq')
      .all(board, principal);
    return rows.flatMap(({ prompt, reply }) => [
      { role: 'user', content: prompt },
      { role: 'assistant', content: reply },
    ]);
  }

  completed(board: string, principal: string, turn: string) {
    return Boolean(
      this.db
        .query('SELECT 1 FROM chat_turns WHERE board_id=? AND principal=? AND turn_id=?')
        .get(board, principal, turn),
    );
  }

  append(board: string, principal: string, turn: string, prompt: string, reply: string) {
    this.db.transaction(() => {
      this.db
        .query('INSERT INTO chat_turns(board_id,principal,turn_id,prompt,reply) VALUES(?,?,?,?,?)')
        .run(board, principal, turn, prompt, reply);
      this.db
        .query(
          `DELETE FROM chat_turns WHERE board_id=? AND principal=? AND seq <= (
        SELECT seq FROM chat_turns WHERE board_id=? AND principal=? ORDER BY seq DESC LIMIT 1 OFFSET 40
      )`,
        )
        .run(board, principal, board, principal);
    })();
  }
}

export function modelHistory(messages: ChatMessage[], prompt: string): ChatMessage[] {
  let length = prompt.length;
  let start = messages.length;
  while (start >= 2 && messages.length - start < 24) {
    length += messages[start - 1].content.length + messages[start - 2].content.length;
    if (length > 60000) break;
    start -= 2;
  }
  return [...messages.slice(start), { role: 'user', content: prompt }];
}
