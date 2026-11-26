/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisAgentChatMessage, IParadisAgentInteraction } from '../../../agentChat/common/paradisAgentChat.js';
import { paradisInboxAskDangerLabels, paradisInboxAskLayout } from '../../../notificationInbox/common/paradisNotificationInboxAsk.js';
import { IParadisHumanAskInput } from '../../common/paradisHumanAsk.js';
import { IParadisHumanAskPaneLabel, IParadisHumanAskPaneState, paradisHumanAskPaneDelivery, paradisHumanAskPaneInput } from '../../common/paradisHumanAskPane.js';

const LABEL: IParadisHumanAskPaneLabel = { windowId: 3, stateKey: 'space-1', space: 'api', worktree: 'fix-login', tab: 'claude' };

function question(index: number, text: string, options: readonly string[], extra: Partial<IParadisAgentChatMessage> = {}): IParadisAgentChatMessage {
	return { rev: index, role: 'assistant', kind: 'question', text, options: options.map(label => ({ label })), toolUseId: `q${index}`, questionGroup: 'g1', questionIndex: index, ...extra };
}

function state(interaction: IParadisAgentInteraction, extra: Partial<IParadisHumanAskPaneState> = {}): IParadisHumanAskPaneState {
	return { paneKey: 'pane-key', agent: 'claude', epoch: 'e1', interaction, questions: [], personOnly: false, ...extra };
}

const APPROVAL: IParadisAgentInteraction = {
	kind: 'approval', id: 'toolu_1', title: '操作の許可', detail: 'Bash: npm run typecheck-client',
	choices: [{ id: 'yes', label: '許可', tone: 'approve' }, { id: 'always', label: '今後も許可', tone: 'neutral' }, { id: 'no', label: '拒否', tone: 'deny' }],
};

/** 押せるもの（問いの選択肢の数・ボタンの id）だけを抜き出す。 */
function pressable(input: IParadisHumanAskInput | undefined): string {
	return input === undefined ? 'none' : `${input.kind} questions=[${input.questions.map(item => `${item.options.length}${item.allowText ? '+text' : ''}${item.multiSelect ? '+multi' : ''}`).join(',')}] actions=[${input.actions.map(action => action.id).join(',')}]`;
}

suite('Paradis human ask: pane asks', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a pane question becomes one entry with its questions, and a permission offers allow and deny only', () => {
		const asked = paradisHumanAskPaneInput(state({ kind: 'question', id: 'g1' }, {
			questions: [question(0, 'どちらにしますか?', ['残す', 'ログアウトさせる']), question(1, '対象は?', ['A', 'B', 'C'], { multiSelect: true })],
		}), LABEL);
		const permission = paradisHumanAskPaneInput(state(APPROVAL), LABEL);
		assert.deepStrictEqual({
			asked: asked && { ...asked, questions: asked.questions.map(item => ({ ...item, options: item.options.map(option => option.label) })) },
			permission,
		}, {
			asked: {
				source: 'pane', id: 'pane-key:e1:g1', kind: 'question', from: { title: 'api', detail: 'fix-login ／ claude ／ Claude Code' },
				questions: [
					{ id: '0', text: 'どちらにしますか?', options: ['残す', 'ログアウトさせる'], allowText: true },
					{ id: '1', text: '対象は?', options: ['A', 'B', 'C'], allowText: true, multiSelect: true },
				],
				actions: [], canSkip: false, paneKey: 'pane-key', windowId: 3, stateKey: 'space-1',
			},
			permission: {
				source: 'pane', id: 'pane-key:e1:toolu_1', kind: 'permission', from: { title: 'api', detail: 'fix-login ／ claude ／ Claude Code' },
				preface: 'Bash: npm run typecheck-client', questions: [],
				// 「今後も許可」は載せない（ペインで答える）
				actions: [{ id: 'yes', label: '許可' }, { id: 'no', label: '拒否' }],
				canSkip: false, paneKey: 'pane-key', windowId: 3, stateKey: 'space-1',
			},
		});
	});

	test('only known, complete and harmless permissions may be allowed from the row; the rest go to the dialog or the pane', () => {
		type Request = NonNullable<Extract<IParadisAgentInteraction, { kind: 'approval' }>['request']>;
		const approval = (request: Request | undefined, detail = 'Bash: something') => paradisHumanAskPaneInput(state({ ...APPROVAL, detail, request }), LABEL);
		const row = (input: IParadisHumanAskInput | undefined) => input === undefined ? 'none' : `${paradisInboxAskLayout({ ...input, state: 'waiting' })} [${input.actions.map(action => action.id).join(',')}] ${paradisInboxAskDangerLabels(input.preface).join('|')}`.trim();
		const table = {
			// 許可リスト: Bash（全文が短く札なし）・読むだけの道具
			bash: row(approval({ tool: 'Bash', kind: 'bash', command: 'npm test' })),
			read: row(approval({ tool: 'Read', kind: 'other', path: '/w/a.ts', args: [{ key: 'file_path', value: '/w/a.ts' }] })),
			// 説明で隠した rm -rf・1500 字より後ろの強制 push: 札が付くのでモーダル
			bashHidden: row(approval({ tool: 'Bash', kind: 'bash', description: 'Clean junk', command: 'rm -rf ./junk' }, 'Bash: Clean junk')),
			bashLate: row(approval({ tool: 'Bash', kind: 'bash', command: `echo ${'a'.repeat(1600)} && git push --force origin main` })),
			// 形は分かるが書き込む・外へ出る・形が分からない: モーダル
			edit: row(approval({ tool: 'Edit', kind: 'edit', path: '/w/a.ts', oldText: 'a', newText: 'b' })),
			write: row(approval({ tool: 'Write', kind: 'write', path: '/w/a.ts', content: 'x', contentLines: 1 })),
			fetch: row(approval({ tool: 'WebFetch', kind: 'fetch', url: 'https://example.com' })),
			mcp: row(approval({ tool: 'mcp__db__run_query', kind: 'mcp', mcpServer: 'db', mcpTool: 'run_query', args: [{ key: 'sql', value: 'select 1' }] })),
			other: row(approval({ tool: 'Task', kind: 'other', args: [{ key: 'prompt', value: 'do it' }] })),
			noRequest: row(approval(undefined, 'Bash: Clean junk')),
			// 中継で切られた中身: 受信箱からは答えさせない（ペインへ）
			truncated: row(approval({ tool: 'Write', kind: 'write', path: '/w/a.ts', content: 'x', contentLines: 900, truncated: true })),
		};
		const mcp = approval({ tool: 'mcp__db__run_query', kind: 'mcp', mcpServer: 'db', mcpTool: 'run_query', args: [{ key: 'sql', value: 'DROP TABLE users' }, { key: 'database', value: 'prod' }] });
		const edit = approval({ tool: 'Edit', kind: 'edit', path: '/w/a.ts', oldText: 'const a = 1;\nconst b = 2;', newText: 'const a = 3;' });
		const truncated = approval({ tool: 'Bash', kind: 'bash', command: 'x'.repeat(20), truncated: true });
		assert.deepStrictEqual({ table, mcp: mcp?.preface, edit: edit?.preface, truncated: truncated?.preface?.split('\n').pop() }, {
			table: {
				bash: 'inline-actions [yes,no]',
				read: 'inline-actions [yes,no]',
				bashHidden: 'dialog [yes,no] 削除を含む',
				bashLate: 'dialog [yes,no] 強制 push',
				edit: 'dialog [yes,no]',
				write: 'dialog [yes,no]',
				fetch: 'dialog [yes,no]',
				mcp: 'dialog [yes,no]',
				other: 'dialog [yes,no]',
				noRequest: 'dialog [yes,no]',
				truncated: 'unanswerable []',
			},
			// MCP の引数は全部、数と長さを添えて出す
			mcp: 'mcp__db__run_query\n引数 2 個\nsql（16 字）: DROP TABLE users\ndatabase（4 字）: prod',
			// Edit は置き換え前と置き換え後
			edit: 'Edit: /w/a.ts\n- const a = 1;\n- const b = 2;\n+ const a = 3;',
			truncated: '（中身が長いため途中までの表示です。全文を見て答えるにはペインを開いてください）',
		});
	});

	test('asks that must be answered in the terminal carry nothing to press', () => {
		const mcp = { tool: 'mcp__db__run', kind: 'mcp', mcpServer: 'db', mcpTool: 'run' } as NonNullable<Extract<IParadisAgentInteraction, { kind: 'approval' }>['request']>;
		assert.deepStrictEqual([
			// 端末の確認の画面でしか許可できない（カードの印・印が付く前の mod の知らせ）
			pressable(paradisHumanAskPaneInput(state({ ...APPROVAL, answerOn: 'pc', choices: [{ id: 'no', label: '拒否', tone: 'deny' }] }), LABEL)),
			pressable(paradisHumanAskPaneInput(state(APPROVAL, { personOnly: true }), LABEL)),
			// 読むだけの印・時間切れ
			pressable(paradisHumanAskPaneInput(state({ ...APPROVAL, readOnly: true }), LABEL)),
			pressable(paradisHumanAskPaneInput(state({ ...APPROVAL, expired: true, choices: [] }), LABEL)),
			// Codex の MCP のツールの許可（4 択のフォーム）。同じ MCP の許可でも Claude Code は押せる
			pressable(paradisHumanAskPaneInput(state({ ...APPROVAL, request: mcp }, { agent: 'codex' }), LABEL)),
			pressable(paradisHumanAskPaneInput(state({ ...APPROVAL, request: mcp }), LABEL)),
			// キーで答えられない種類（OpenCode・Antigravity CLI）
			pressable(paradisHumanAskPaneInput(state(APPROVAL, { agent: 'opencode' }), LABEL)),
			pressable(paradisHumanAskPaneInput(state({ kind: 'question', id: 'g1' }, { agent: 'antigravity', questions: [question(0, 'どれ?', ['A', 'B'])] }), LABEL)),
			// 台帳の上限（選択肢 8 つ）を超える質問は、切らずに「ペインへ移動」だけにする
			pressable(paradisHumanAskPaneInput(state({ kind: 'question', id: 'g1' }, { questions: [question(0, 'どれ?', ['1', '2', '3', '4', '5', '6', '7', '8', '9'])] }), LABEL)),
			// preview のある質問は自分で書けない
			pressable(paradisHumanAskPaneInput(state({ kind: 'question', id: 'g1' }, { questions: [question(0, 'どれ?', ['A', 'B'], { options: [{ label: 'A', preview: '# A' }, { label: 'B' }] })] }), LABEL)),
		], [
			'permission questions=[] actions=[]',
			'permission questions=[] actions=[]',
			'permission questions=[] actions=[]',
			'permission questions=[] actions=[]',
			'permission questions=[] actions=[]',
			'permission questions=[] actions=[yes,no]',
			'permission questions=[] actions=[]',
			'question questions=[] actions=[]',
			'question questions=[] actions=[]',
			'question questions=[2] actions=[]',
		]);
	});

	test('an answer is turned into the terminal answer only when every question is answered one way', () => {
		const asked = paradisHumanAskPaneInput(state({ kind: 'question', id: 'g1' }, {
			questions: [question(0, 'どちら?', ['残す', 'ログアウト']), question(1, '対象は?', ['A', 'B', 'C'], { multiSelect: true }), question(2, 'ほかには?', [])],
		}), LABEL)!;
		const permission = paradisHumanAskPaneInput(state(APPROVAL), LABEL)!;
		assert.deepStrictEqual([
			paradisHumanAskPaneDelivery(asked, { type: 'answers', answers: [{ questionId: '0', optionIds: ['1'] }, { questionId: '1', optionIds: ['0', '2'] }, { questionId: '2', text: 'なし' }] }),
			// 1 問だけ・選択と自由入力の両方・飛ばす は届けない
			paradisHumanAskPaneDelivery(asked, { type: 'answers', answers: [{ questionId: '0', optionIds: ['1'] }] }),
			paradisHumanAskPaneDelivery(asked, { type: 'answers', answers: [{ questionId: '0', optionIds: ['1'], text: 'メモ' }, { questionId: '1', optionIds: ['0'] }, { questionId: '2', text: 'なし' }] }),
			paradisHumanAskPaneDelivery(asked, { type: 'skip' }),
			paradisHumanAskPaneDelivery(permission, { type: 'action', actionId: 'yes' }),
			paradisHumanAskPaneDelivery(permission, { type: 'action', actionId: 'no' }),
			// 載せていないボタン・ひとこと付きは届けない
			paradisHumanAskPaneDelivery(permission, { type: 'action', actionId: 'always' }),
			paradisHumanAskPaneDelivery(permission, { type: 'action', actionId: 'no', text: 'やめて' }),
		], [
			{ kind: 'question', answers: [{ kind: 'option', index: 1 }, { kind: 'multi', indices: [0, 2] }, { kind: 'text', optionCount: 0, text: 'なし' }] },
			undefined,
			undefined,
			undefined,
			{ kind: 'approval', choiceId: 'yes' },
			{ kind: 'approval', choiceId: 'no' },
			undefined,
			undefined,
		]);
	});
});
