/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 中継の読むだけの口（ParadisMobileAgentChat.humanAskPanes と、その読み直しの知らせ）を、本物の中継に hook を流して確かめる。
// 台帳の持ち主は「知らせが来たら読む」だけなので、待ちが出たとき・消えたときに知らせが来ないと、カードが出ない・残る。

import assert from 'assert';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisClaudeConfigDir } from '../../../agentBrowser/node/paradisAgentHome.js';
import { fireParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { ParadisMobileAgentChat } from '../../../mobileRelay/node/paradisMobileAgentChat.js';
import { paradisInboxPaneKey } from '../../../notificationInbox/common/paradisNotificationInbox.js';

/** 読み直しの知らせが来るたびに確かめ、条件が満たされたら終わる（満たされなければテストの時間切れで落ちる）。 */
function until(chat: ParadisMobileAgentChat, predicate: () => boolean): Promise<void> {
	return new Promise<void>(resolve => {
		if (predicate()) {
			resolve();
			return;
		}
		const listener = chat.onDidCheckDesktopPanes(() => {
			if (predicate()) {
				listener.dispose();
				resolve();
			}
		});
	});
}

suite('Paradis human ask: pane source (relay)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the relay tells the reader when a wait appears, when a hook ends it, and when it ends without a hook', async () => {
		const token = 'pane-human-ask-source';
		const sessionId = 'session-human-ask-source';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'human-ask-source.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		// 持ち主と同じく、知らせの中で読む
		const seen: string[] = [];
		const listener = chat.onDidCheckDesktopPanes(() => {
			const view = chat.humanAskPanes().map(pane => `${pane.interaction.kind}:${pane.interaction.kind === 'approval' ? pane.interaction.detail : pane.questions.length}`).join(',');
			if (seen[seen.length - 1] !== view) {
				seen.push(view);
			}
		});
		const base = { token, sessionId, transcriptPath, cwd: '/workspace' };
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			// スマホは繋いでいない。ウィンドウがペインを見ている（PC のチャット表示・タスクボードがしていること）
			chat.watchDesktopChat('window-1', [token]);
			fireParadisAgentHookEvent({ ...base, event: 'UserPromptSubmit', at: Date.now() });
			fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'toolu_1' });
			fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm test' } });
			await until(chat, () => seen.includes('approval:Bash: npm test'));
			const pane = chat.humanAskPanes()[0];
			const listed = { paneKey: pane.paneKey === paradisInboxPaneKey(token), hasToken: JSON.stringify(pane).includes(token), id: pane.interaction.id, personOnly: pane.personOnly };

			// hook で終わる（ツールが走り終えた）
			fireParadisAgentHookEvent({ ...base, event: 'PostToolUse', at: Date.now(), toolName: 'Bash', toolUseId: 'toolu_1' });
			await until(chat, () => seen[seen.length - 1] === '');

			// hook を通らずに終わる（PC のチャット・受信箱からキーで答えた印。Claude Code は Esc の拒否でも hook を出さない）
			fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run build' }, toolUseId: 'toolu_2' });
			fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run build' } });
			await until(chat, () => seen[seen.length - 1] === 'approval:Bash: npm run build');
			assert.strictEqual(chat.claimDesktopInteraction(token, 'approval', 'toolu_2'), true);
			chat.releaseDesktopInteraction(token, 'approval', 'toolu_2', true);
			await until(chat, () => seen[seen.length - 1] === '');

			// 最初の許可より前の確かめ直し（待ちなし）は、間に合えば 1 回入る。比べるのは許可が出てから
			assert.deepStrictEqual({ listed, seen: seen.slice(seen.indexOf('approval:Bash: npm test')) }, {
				// ペインのトークンは返さない
				listed: { paneKey: true, hasToken: false, id: 'toolu_1', personOnly: false },
				seen: ['approval:Bash: npm test', '', 'approval:Bash: npm run build', ''],
			});
		} finally {
			listener.dispose();
			chat.dispose();
		}
	});

	test('with the ledger reading, a pane nobody watches still gets its wait (no phone, chat display off)', async () => {
		const token = 'pane-human-ask-unwatched';
		const sessionId = 'session-human-ask-unwatched';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'human-ask-unwatched.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const base = { token, sessionId, transcriptPath, cwd: '/workspace' };
		let reading: IDisposable | undefined;
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			// 読む側がいないうちは、見られていないペインの許可で tailer を起こさない（今までどおり）
			fireParadisAgentHookEvent({ ...base, event: 'UserPromptSubmit', at: Date.now() });
			fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'toolu_1' });
			fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm test' } });
			const before = chat.humanAskPanes().length;
			fireParadisAgentHookEvent({ ...base, event: 'PostToolUse', at: Date.now(), toolName: 'Bash', toolUseId: 'toolu_1' });

			// 台帳の書き手が読み始めた: ウィンドウもスマホも見ていないペインの許可が一覧に出る
			reading = chat.retainHumanAskTailing();
			fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run build' }, toolUseId: 'toolu_2' });
			fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run build' } });
			await until(chat, () => chat.humanAskPanes().length > 0);
			const listed = chat.humanAskPanes().map(pane => ({ id: pane.interaction.id, detail: pane.interaction.kind === 'approval' ? pane.interaction.detail : undefined }));
			// 受信箱からの回答がウィンドウで取る claim も、見られていないペインで取れる（PC のチャット・スマホと同じ口）
			const claimed = chat.claimDesktopInteraction(token, 'approval', 'toolu_2');
			chat.releaseDesktopInteraction(token, 'approval', 'toolu_2', false);
			assert.deepStrictEqual({ before, listed, claimed }, { before: 0, listed: [{ id: 'toolu_2', detail: 'Bash: npm run build' }], claimed: true });
		} finally {
			reading?.dispose();
			chat.dispose();
		}
	});

	test('two readers: the first one to stop does not stop the other; after both stop, a new approval is not taken in', async () => {
		const token = 'pane-human-ask-two-readers';
		const sessionId = 'session-human-ask-two-readers';
		const transcriptPath = join(paradisClaudeConfigDir(), 'projects', 'para-code-tests', 'human-ask-two-readers.jsonl');
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService());
		const base = { token, sessionId, transcriptPath, cwd: '/workspace' };
		const first = chat.retainHumanAskTailing();
		const second = chat.retainHumanAskTailing();
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ ...base, event: 'UserPromptSubmit', at: Date.now() });
			// 片方がやめた（二度 dispose しても、もう片方の分は減らない）
			first.dispose();
			first.dispose();
			fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'toolu_1' });
			fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm test' } });
			await until(chat, () => chat.humanAskPanes().length > 0);
			const whileOneReads = chat.humanAskPanes().map(pane => pane.interaction.id);
			fireParadisAgentHookEvent({ ...base, event: 'PostToolUse', at: Date.now(), toolName: 'Bash', toolUseId: 'toolu_1' });
			await until(chat, () => chat.humanAskPanes().length === 0);

			// 両方やめた: 見られていないペインの次の許可は入れない（今までどおり）
			second.dispose();
			fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run build' }, toolUseId: 'toolu_2' });
			fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run build' } });
			const afterBoth = chat.humanAskPanes().length;

			// また読み始めると、次の許可は入る
			const again = chat.retainHumanAskTailing();
			try {
				fireParadisAgentHookEvent({ ...base, event: 'PostToolUse', at: Date.now(), toolName: 'Bash', toolUseId: 'toolu_2' });
				fireParadisAgentHookEvent({ ...base, event: 'PreToolUse', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run lint' }, toolUseId: 'toolu_3' });
				fireParadisAgentHookEvent({ ...base, event: 'PermissionRequest', at: Date.now(), toolName: 'Bash', toolInput: { command: 'npm run lint' } });
				await until(chat, () => chat.humanAskPanes().length > 0);
				const readAgain = chat.humanAskPanes().map(pane => pane.interaction.id);
				assert.deepStrictEqual({ whileOneReads, afterBoth, readAgain }, { whileOneReads: ['toolu_1'], afterBoth: 0, readAgain: ['toolu_3'] });
			} finally {
				again.dispose();
			}
		} finally {
			first.dispose();
			second.dispose();
			chat.dispose();
		}
	});
});
