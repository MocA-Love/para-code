/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話の記録を追いかけている tailer（ParadisMobileAgentChat）から、資料の台帳までを通しで確かめる。
// 記録のファイルへ行を足す → tailer が読む → 行のバス → 台帳、の経路で、hook の書き込みの知らせは 1 つも送らない。

import assert from 'assert';
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { fireParadisAgentHookEvent, onParadisAgentHookEvent } from '../../../agentBrowser/node/paradisAgentHookBus.js';
import { onParadisAgentTranscriptEntries } from '../../../agentBrowser/node/paradisAgentTranscriptEntryBus.js';
import { ParadisMobileAgentChat } from '../../../mobileRelay/node/paradisMobileAgentChat.js';
import { ParadisRemoteTranscriptMirrorStore } from '../../../mobileRelay/node/paradisRemoteTranscriptMirror.js';
import { ParadisAgentDocsLedger } from '../../node/paradisAgentDocsLedger.js';
import { ParadisAgentDocsService } from '../../node/paradisAgentDocsService.js';

/** 台帳にその資料が載るまで待つ（台帳の変更の知らせで待つ。届かなければテストの時間切れで落ちる）。 */
async function untilListed(ledger: ParadisAgentDocsLedger, hostId: string, path: string): Promise<void> {
	while (ledger.get(hostId, path) === undefined) {
		await Event.toPromise(ledger.onDidChange);
	}
}

/** Claude Code の記録の、書き込みの呼び出しの行と結果の行。 */
function writeLines(id: string, filePath: string, at = new Date().toISOString()): string {
	return [
		{ type: 'assistant', uuid: `u-${id}`, timestamp: at, cwd: '/srv/app', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Write', input: { file_path: filePath, content: '<h1>x</h1>' } }] } },
		{ type: 'user', uuid: `r-${id}`, timestamp: at, cwd: '/srv/app', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '', is_error: false }] } },
	].map(line => JSON.stringify(line) + '\n').join('');
}

suite('paradisAgentDocs transcript tail', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function createDocs(): { ledger: ParadisAgentDocsLedger; service: ParadisAgentDocsService } {
		const store = disposables.add(new DisposableStore());
		const ledger = store.add(new ParadisAgentDocsLedger({ read: async () => undefined, write: async () => { } }, error => { throw error; }));
		return { ledger, service: store.add(new ParadisAgentDocsService(ledger, onParadisAgentHookEvent, onParadisAgentTranscriptEntries)) };
	}

	test('a write appended to the local transcript reaches the ledger without any tool hook', async function () {
		this.timeout(20_000);
		const home = await realpath(await mkdtemp(join(tmpdir(), 'paradis-docs-tail-')));
		const previous = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = home;
		const session = '11111111-2222-4333-8444-555555555555';
		const transcript = join(home, 'projects', 'p', `${session}.jsonl`);
		await mkdir(join(home, 'projects', 'p'), { recursive: true });
		// Para Code が止まっていた間に書かれた分（起動の後の読み込みで拾う）
		await writeFile(transcript, writeLines('toolu_before', '/srv/app/before.md'));
		const { ledger } = createDocs();
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService(), async () => true);
		const token = 'pane-docs-local';
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: session, transcriptPath: transcript, cwd: '/srv/app', at: Date.now() });
			await untilListed(ledger, '', '/srv/app/before.md');
			await appendFile(transcript, writeLines('toolu_live', '/srv/app/live.html'));
			await untilListed(ledger, '', '/srv/app/live.html');
			assert.deepStrictEqual(ledger.all().map(record => [record.hostId, record.path, record.owner?.session, record.owner?.via, record.writes.map(write => write.toolUseId)]), [
				['', '/srv/app/before.md', session, 'write', ['toolu_before']],
				['', '/srv/app/live.html', session, 'write', ['toolu_live']],
			]);
		} finally {
			chat.dispose();
			if (previous === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previous;
			}
			await rm(home, { recursive: true, force: true });
		}
	});

	test('old lines in a transcript that appears after the pane was followed do not take a document from its owner', async function () {
		this.timeout(20_000);
		const home = await realpath(await mkdtemp(join(tmpdir(), 'paradis-docs-tail-')));
		const previous = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = home;
		const parent = '33333333-4444-4555-8666-777777777777';
		const fork = '44444444-5555-4666-8777-888888888888';
		const transcript = join(home, 'projects', 'p', `${fork}.jsonl`);
		await mkdir(join(home, 'projects', 'p'), { recursive: true });
		const { ledger } = createDocs();
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService(), async () => true);
		const token = 'pane-docs-fork';
		try {
			// 元の会話が書いた資料（別の会話が引き取った）と、元の会話が持ち主の資料
			await ledger.ready;
			ledger.recordWrite('', '/srv/app/adopted.md', { agent: 'claude', session: parent }, { at: Date.now() - 3_600_000, tool: 'Write', toolUseId: 'toolu_parent_1' });
			ledger.adopt('', '/srv/app/adopted.md', { agent: 'claude', session: 'other-session' });
			ledger.recordWrite('', '/srv/app/parent.md', { agent: 'claude', session: parent }, { at: Date.now() - 3_600_000, tool: 'Write', toolUseId: 'toolu_parent_2' });
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			// 記録のファイルは、ペインの会話が決まった後でできる。中身は元の会話から写された 1 時間前の行と、今の書き込み
			fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: fork, transcriptPath: transcript, cwd: '/srv/app', at: Date.now() });
			const old = new Date(Date.now() - 3_600_000).toISOString();
			await writeFile(transcript, writeLines('toolu_parent_1', '/srv/app/adopted.md', old) + writeLines('toolu_parent_2', '/srv/app/parent.md', old) + writeLines('toolu_fork', '/srv/app/fork.html'));
			await untilListed(ledger, '', '/srv/app/fork.html');
			assert.deepStrictEqual(ledger.all().map(record => [record.path, record.owner?.session, record.owner?.via]), [
				['/srv/app/adopted.md', 'other-session', 'adopt'],
				['/srv/app/parent.md', parent, 'write'],
				['/srv/app/fork.html', fork, 'write'],
			]);
		} finally {
			chat.dispose();
			if (previous === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previous;
			}
			await rm(home, { recursive: true, force: true });
		}
	});

	test('a write appended to the copy of an SSH transcript reaches the ledger under the host of the pane', async function () {
		this.timeout(20_000);
		const userData = await realpath(await mkdtemp(join(tmpdir(), 'paradis-docs-mirror-')));
		const mirror = new ParadisRemoteTranscriptMirrorStore(userData, new NullLogService());
		const { ledger, service } = createDocs();
		const chat = new ParadisMobileAgentChat(() => { }, () => { }, () => { }, new NullLogService(), async () => true, () => { }, undefined, mirror);
		const token = 'pane-docs-remote';
		const session = '22222222-3333-4444-8555-666666666666';
		const remotePath = `/home/alice/.claude/projects/-srv-app/${session}.jsonl`;
		const encoder = new TextEncoder();
		try {
			assert.strictEqual(chat.syncPanes(1, 'window-session', 1, 1, [{ terminalId: 1, token }]), true);
			// SSH の窓の hook の形（接続先の印と、プロセスで確かめられなかった印の両方が付く）
			const followed = Event.toPromise(Event.filter(chat.onDidChangeConfirmedAgentPanes, change => change.tokens.includes(token)));
			fireParadisAgentHookEvent({ token, event: 'SessionStart', sessionId: session, transcriptPath: remotePath, cwd: '/srv/app', remoteHostId: 'ssh-remote-server', ownerUnverified: true, payload: { source: 'startup' }, at: Date.now() });
			await followed;
			// 担当のウィンドウが接続先の記録の追記を写す
			await mirror.begin('window-a', remotePath);
			await mirror.append('window-a', remotePath, encoder.encode(writeLines('toolu_remote', '/srv/app/report.html')));
			await untilListed(ledger, 'ssh-remote-server', '/srv/app/report.html');
			// 写しのファイルができた後の追記は、ファイルの監視で届く（最初の 1 回は、写しがまだ無いのでポーリングで拾う）
			await mirror.append('window-a', remotePath, encoder.encode(writeLines('toolu_remote_2', '/srv/app/second.md')));
			await untilListed(ledger, 'ssh-remote-server', '/srv/app/second.md');
			assert.deepStrictEqual({
				docs: ledger.all().map(record => [record.hostId, record.path, record.owner?.session, record.owner?.cwd]),
				pane: service.sessionOf(token)?.hostId,
			}, {
				docs: [['ssh-remote-server', '/srv/app/report.html', session, '/srv/app'], ['ssh-remote-server', '/srv/app/second.md', session, '/srv/app']],
				pane: 'ssh-remote-server',
			});
		} finally {
			chat.dispose();
			mirror.dispose();
			await rm(userData, { recursive: true, force: true });
		}
	});
});
