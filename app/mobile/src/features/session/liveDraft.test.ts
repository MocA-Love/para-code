// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import type { AgentChatMessage } from '../../store.js';
import { liveDraftOf, splitLiveDraft } from './liveDraft.js';

const message = (rev: number, role: AgentChatMessage['role'], kind: AgentChatMessage['kind'], text: string): AgentChatMessage => ({ rev, role, kind, text });
const live = (text: string) => ({ phase: 'message' as const, source: 'hook' as const, startedAt: 1, updatedAt: 2, text });

describe('splitLiveDraft（案 C: 確定した行と書きかけの 1 行）', () => {
	it('splits at the last newline, marks bullets, puts an open code block in the frame, and drops the tail when final', () => {
		expect({
			plain: splitLiveDraft('原因が分かりました。\n直し方は 2 つ'),
			firstLine: splitLiveDraft('原因が'),
			newline: splitLiveDraft('一行目\n'),
			bullet: splitLiveDraft('直し方は 2 つあります。\n- 古い行は `final_answer` として'),
			code: splitLiveDraft('例:\n```ts\nif (phase === undefined) {\n\treturn'),
			closed: splitLiveDraft('```ts\nx\n```\n後者は'),
			final: splitLiveDraft('全部\n書けた', { final: true }),
			window: splitLiveDraft('末尾\nの文', { textOffset: 10 }),
		}).toEqual({
			plain: { committed: '原因が分かりました。', tail: '直し方は 2 つ', inCode: false, caret: true },
			firstLine: { committed: '', tail: '原因が', inCode: false, caret: true },
			newline: { committed: '一行目', tail: '', inCode: false, caret: true },
			bullet: { committed: '直し方は 2 つあります。', tail: '• 古い行は `final_answer` として', inCode: false, caret: true },
			code: { committed: '例:\n```ts\nif (phase === undefined) {\n\treturn\n```', tail: '', inCode: true, caret: true },
			closed: { committed: '```ts\nx\n```', tail: '後者は', inCode: false, caret: true },
			final: { committed: '全部\n書けた', tail: '', inCode: false, caret: false },
			window: { committed: '…末尾', tail: 'の文', inCode: false, caret: true },
		});
	});
});

describe('liveDraftOf', () => {
	it('shows only Claude Code message drafts and hides one that the confirmed reply already shows', () => {
		const asked = [message(0, 'user', 'text', '直して')];
		const confirmed = [...asked, message(1, 'assistant', 'text', '直しました。\n確認してください。')];
		const longConfirmed = [...asked, message(1, 'assistant', 'text', `${'あ'.repeat(6_000)}…`)];
		expect({
			claude: liveDraftOf({ agent: 'claude', live: live('直して'), messages: asked })?.text,
			codex: liveDraftOf({ agent: 'codex', live: live('直して'), messages: asked }),
			tool: liveDraftOf({ agent: 'claude', live: { phase: 'tool', source: 'hook', startedAt: 1, updatedAt: 2, tool: 'Bash' }, messages: asked }),
			blank: liveDraftOf({ agent: 'claude', live: live('\n '), messages: asked }),
			sameAsConfirmed: liveDraftOf({ agent: 'claude', live: live('直しました。\n確認して'), messages: confirmed }),
			longerThanCut: liveDraftOf({ agent: 'claude', live: live(`${'あ'.repeat(6_500)}`), messages: longConfirmed }),
			nextBlock: liveDraftOf({ agent: 'claude', live: live('次に'), messages: confirmed })?.text,
		}).toEqual({
			claude: '直して',
			codex: undefined,
			tool: undefined,
			blank: undefined,
			sameAsConfirmed: undefined,
			longerThanCut: undefined,
			nextBlock: '次に',
		});
	});
});
