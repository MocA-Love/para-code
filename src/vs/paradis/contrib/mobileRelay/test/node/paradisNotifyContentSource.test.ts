/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisNotifyHookLedger, paradisApprovalNotifyContent, paradisResolveNotifyContent } from '../../node/paradisNotifyContentSource.js';

function hook(event: string, fields: Partial<IParadisAgentHookEvent> = {}): IParadisAgentHookEvent {
	return { token: 'tok', event, sessionId: undefined, transcriptPath: undefined, cwd: undefined, at: 1000, ...fields };
}

suite('ParadisNotifyHookLedger', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('Stop の発言・StopFailure の理由・承認の中身を覚え、次の依頼で忘れる', () => {
		const ledger = store.add(new ParadisNotifyHookLedger(false));
		ledger.record(hook('Stop', { payload: { last_assistant_message: '終わりました' } }));
		const done = ledger.turnEnd('tok', 2000);
		ledger.record(hook('StopFailure', { payload: { error: 'rate_limit', error_details: 'Rate limit reached' } }));
		const failed = ledger.turnEnd('tok', 2000);
		ledger.record(hook('PermissionRequest', { toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'toolu_9' }));
		const approval = ledger.approval('tok', 2000);
		const stale = ledger.turnEnd('tok', 1000 + 3 * 60_000);
		ledger.record(hook('UserPromptSubmit'));
		assert.deepStrictEqual([done, failed, approval, stale, ledger.turnEnd('tok', 2000), ledger.approval('tok', 2000)], [
			{ failed: false, lastMessage: '終わりました', at: 1000 },
			{ failed: true, errorCode: 'rate_limit', errorMessage: 'Rate limit reached', at: 1000 },
			{ toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'toolu_9', at: 1000 },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('AskUserQuestion の許可要求は承認として覚えない', () => {
		const ledger = store.add(new ParadisNotifyHookLedger(false));
		ledger.record(hook('PermissionRequest', { toolName: 'AskUserQuestion', toolInput: {} }));
		assert.strictEqual(ledger.approval('tok', 1000), undefined);
	});
});

suite('paradisResolveNotifyContent', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('完了: hook の発言 → hook の失敗 → transcript の失敗 → transcript の発言の順に見る', () => {
		const now = 10_000;
		assert.deepStrictEqual([
			paradisResolveNotifyContent({ kind: 'agent-done', hookTurnEnd: { failed: false, lastMessage: 'hook の発言', at: now }, pane: { lastAssistant: { text: 'tail', isError: false } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-done', hookTurnEnd: { failed: true, errorCode: 'rate_limit', errorMessage: '止まった', at: now }, now }),
			paradisResolveNotifyContent({ kind: 'agent-done', pane: { turnEnd: { reason: 'failed', errorCode: 'usage_limit_exceeded', at: now }, lastAssistant: { text: 'You hit your usage limit', isError: true } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-done', pane: { lastAssistant: { text: 'tail の発言', isError: false } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-done', pane: { lastAssistant: { text: 'API Error: 500', isError: true } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-done', now }),
			paradisResolveNotifyContent({ kind: 'disconnected', now }),
			// hook の終わりより transcript の失敗のほうが新しい → 失敗
			paradisResolveNotifyContent({ kind: 'agent-done', hookTurnEnd: { failed: false, lastMessage: '前のターン', at: now - 5000 }, pane: { turnEnd: { reason: 'failed', errorCode: 'usage_limit_exceeded', at: now }, lastAssistant: { text: 'limit', isError: true } }, now }),
			// transcript の失敗より hook の完了のほうが新しい → 完了
			paradisResolveNotifyContent({ kind: 'agent-done', hookTurnEnd: { failed: false, lastMessage: '今のターン', at: now }, pane: { turnEnd: { reason: 'failed', at: now - 5000 } }, now }),
		], [
			{ kind: 'agent-done', category: 'done', content: 'hook の発言' },
			{ kind: 'agent-error', category: 'error', content: '止まった', errorCode: 'rate_limit' },
			{ kind: 'agent-error', category: 'error', content: 'You hit your usage limit', errorCode: 'usage_limit_exceeded' },
			{ kind: 'agent-done', category: 'done', content: 'tail の発言' },
			{ kind: 'agent-error', category: 'error', content: 'API Error: 500' },
			{ kind: 'agent-done', category: 'done' },
			undefined,
			{ kind: 'agent-error', category: 'error', content: 'limit', errorCode: 'usage_limit_exceeded' },
			{ kind: 'agent-done', category: 'done', content: '今のターン' },
		]);
	});

	test('要対応: 質問はそのまま、承認は hook の中身（無ければ tailer）と ID', () => {
		const now = 10_000;
		assert.deepStrictEqual([
			paradisResolveNotifyContent({ kind: 'agent-question', presetCategory: 'question', presetContent: 'どれ？', now }),
			paradisResolveNotifyContent({ kind: 'agent-question', pane: { interaction: { kind: 'question', id: 'q1', text: 'どちら？' } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-question', hookApproval: { toolName: 'Bash', toolInput: { command: 'npm test', description: 'テスト' }, toolUseId: 'toolu_1', at: now }, pane: { interaction: { kind: 'approval', id: 'toolu_1', text: 'Bash: テスト' } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-question', pane: { interaction: { kind: 'approval', id: 'toolu_2', text: 'Edit: a.ts' } }, now }),
			// hook の承認と待っている承認が別物（ID が違う・hook に ID が無い）→ 待っている承認の中身と ID
			paradisResolveNotifyContent({ kind: 'agent-question', hookApproval: { toolName: 'Bash', toolInput: { command: 'rm -rf build' }, toolUseId: 'toolu_old', at: now }, pane: { interaction: { kind: 'approval', id: 'toolu_3', text: 'Edit: b.ts' } }, now }),
			paradisResolveNotifyContent({ kind: 'agent-question', hookApproval: { toolName: 'Bash', toolInput: { command: 'rm -rf build' }, at: now }, pane: { interaction: { kind: 'approval', id: 'toolu_4', text: 'Edit: c.ts' } }, now }),
			// 待っている承認が無い → hook の中身だけで ID は付けない
			paradisResolveNotifyContent({ kind: 'agent-question', hookApproval: { toolName: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'toolu_5', at: now }, now }),
		], [
			{ kind: 'agent-question', category: 'question', content: 'どれ？' },
			{ kind: 'agent-question', category: 'question', content: 'どちら？', interactionId: 'q1' },
			{ kind: 'agent-question', category: 'approval', content: 'Bash: `npm test`', interactionId: 'toolu_1' },
			{ kind: 'agent-question', category: 'approval', content: 'Edit: a.ts', interactionId: 'toolu_2' },
			{ kind: 'agent-question', category: 'approval', content: 'Edit: b.ts', interactionId: 'toolu_3' },
			{ kind: 'agent-question', category: 'approval', content: 'Edit: c.ts', interactionId: 'toolu_4' },
			{ kind: 'agent-question', category: 'approval', content: 'Bash: `ls`' },
		]);
	});

	test('承認の中身: 長い・複数行のコマンドはコードの枠に入れる', () => {
		assert.deepStrictEqual([
			paradisApprovalNotifyContent('Edit', { file_path: '/repo/a.ts', old_string: 'x' }),
			paradisApprovalNotifyContent('Bash', { command: 'echo a\necho b' }),
			paradisApprovalNotifyContent('WebFetch', undefined),
			paradisApprovalNotifyContent(undefined, { command: 'ls' }),
			// バッククォートを含むコマンドは書き換えず、中身より長い囲いのコードブロックにする
			paradisApprovalNotifyContent('Bash', { command: 'echo `date`' }),
			paradisApprovalNotifyContent('Bash', { command: 'printf "```"' }),
		], [
			'Edit: `/repo/a.ts`',
			'Bash\n\n```\necho a\necho b\n```',
			'WebFetch',
			'操作: `ls`',
			'Bash\n\n```\necho `date`\n```',
			'Bash\n\n````\nprintf "```"\n````',
		]);
	});
});
