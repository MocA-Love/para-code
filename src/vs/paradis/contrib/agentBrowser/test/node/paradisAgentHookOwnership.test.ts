/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHookProcessInfo, ParadisAgentHookOwnership, paradisHookAgentKindFromCommandLine } from '../../node/paradisAgentHookOwnership.js';

suite('ParadisAgentHookOwnership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const CLAUDE_TRANSCRIPT = '/home/user/.claude/projects/-repo/11111111-1111-1111-1111-111111111111.jsonl';
	const CLAUDE_TRANSCRIPT_2 = '/home/user/.claude/projects/-repo/22222222-2222-2222-2222-222222222222.jsonl';
	const CODEX_TRANSCRIPT = '/home/user/.codex/sessions/2026/07/16/rollout-2026-07-16T16-06-01-abc.jsonl';

	function proc(pid: number, ppid: number, command: string, startKey = `start-${pid}`): IParadisHookProcessInfo {
		return { pid, ppid, startKey, command };
	}

	/**
	 * 標準の再現ツリー:
	 *   1 (launchd) ← 100 (zsh, ペインのシェル) ← 200 (claude, 所有者)
	 *     ← 210 (node broker) ← 220 (codex vendor バイナリ, 子エージェント)
	 *       ← 230 (sh hook runner) ← 231 (notify script)
	 *   claude 自身のhookは 205 (sh) ← 206 (notify script) 経由。
	 */
	function standardTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[200, proc(200, 100, 'claude')],
			[205, proc(205, 200, '/bin/sh -c notify')],
			[206, proc(206, 205, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
			[210, proc(210, 200, 'node /home/user/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/app-server-broker.mjs serve')],
			[220, proc(220, 210, '/opt/codex/vendor/bin/codex app-server')],
			[230, proc(230, 220, '/bin/sh -c notify')],
			[231, proc(231, 230, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
	}

	function ownershipWith(tree: Map<number, IParadisHookProcessInfo>): ParadisAgentHookOwnership {
		return new ParadisAgentHookOwnership({ snapshot: async () => tree });
	}

	test('classifies the command line agent kind without matching path fragments', () => {
		assert.deepStrictEqual([
			paradisHookAgentKindFromCommandLine('claude'),
			paradisHookAgentKindFromCommandLine('node /usr/local/bin/claude --resume'),
			paradisHookAgentKindFromCommandLine('/opt/codex/vendor/bin/codex exec --model x'),
			paradisHookAgentKindFromCommandLine('node /home/user/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/codex-companion.mjs task'),
			paradisHookAgentKindFromCommandLine('/bin/zsh -il'),
			paradisHookAgentKindFromCommandLine('node app-server-broker.mjs --cwd /repo'),
		], ['claude', 'claude', 'codex', undefined, undefined, undefined]);
	});

	test('first hook bootstraps the emitting agent as the pane owner', async () => {
		const ownership = ownershipWith(standardTree());
		const result = await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		assert.deepStrictEqual(result, { origin: 'owner', agentKind: 'claude' });
	});

	test('keeps the owner across a transcript change from the same process (/clear)', async () => {
		const ownership = ownershipWith(standardTree());
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const result = await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 });
		assert.strictEqual(result.origin, 'owner');
	});

	test('classifies a codex hook under a live claude owner as nested', async () => {
		const ownership = ownershipWith(standardTree());
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const result = await ownership.classify({ token: 't', hookPid: 231, transcriptPath: CODEX_TRANSCRIPT, at: 2 });
		assert.deepStrictEqual(result, { origin: 'nested', agentKind: 'codex' });
	});

	test('classifies a claude hook under a live codex owner as nested (symmetric)', async () => {
		const tree = new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[300, proc(300, 100, '/opt/codex/vendor/bin/codex')],
			[305, proc(305, 300, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
			[310, proc(310, 300, 'node /usr/local/bin/claude -p "task"')],
			[315, proc(315, 310, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: 305, transcriptPath: CODEX_TRANSCRIPT, at: 1 });
		const result = await ownership.classify({ token: 't', hookPid: 315, transcriptPath: CLAUDE_TRANSCRIPT, at: 2 });
		assert.deepStrictEqual(result, { origin: 'nested', agentKind: 'claude' });
	});

	test('classifies a same-kind nested agent (claude under claude) as nested', async () => {
		const tree = standardTree();
		tree.set(240, proc(240, 200, 'node /usr/local/bin/claude -p "sub"'));
		tree.set(241, proc(241, 240, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh'));
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const result = await ownership.classify({ token: 't', hookPid: 241, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 });
		assert.deepStrictEqual(result, { origin: 'nested', agentKind: 'claude' });
	});

	test('promotes a new owner after the previous owner process exits', async () => {
		const tree = standardTree();
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		tree.delete(200);
		tree.set(220, proc(220, 100, '/opt/codex/vendor/bin/codex'));
		const result = await ownership.classify({ token: 't', hookPid: 231, transcriptPath: CODEX_TRANSCRIPT, at: 2 });
		assert.deepStrictEqual(result, { origin: 'owner', agentKind: 'codex' });
	});

	test('treats a reused owner pid (different start key) as a dead owner', async () => {
		const tree = standardTree();
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		tree.set(200, proc(200, 100, 'claude', 'restarted-later'));
		tree.set(220, proc(220, 100, '/opt/codex/vendor/bin/codex'));
		const result = await ownership.classify({ token: 't', hookPid: 231, transcriptPath: CODEX_TRANSCRIPT, at: 2 });
		assert.strictEqual(result.origin, 'owner');
	});

	test('rejects a hook whose emitter is unrelated to the live owner', async () => {
		const tree = standardTree();
		// 兄弟プロセス: シェル直下で動く別のcodex（所有者claudeの配下ではない）。
		tree.set(400, proc(400, 100, '/opt/codex/vendor/bin/codex'));
		tree.set(401, proc(401, 400, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh'));
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const result = await ownership.classify({ token: 't', hookPid: 401, transcriptPath: CODEX_TRANSCRIPT, at: 2 });
		assert.strictEqual(result.origin, 'invalid');
	});

	test('fail-closed without pid: allows same-transcript and status-only events, rejects rebinds', async () => {
		const ownership = ownershipWith(standardTree());
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 2 })).origin, 'owner');
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: undefined, at: 3 })).origin, 'owner');
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CODEX_TRANSCRIPT, at: 4 })).origin, 'invalid');
	});

	test('fail-closed when the process table is unavailable', async () => {
		const tree = standardTree();
		let available = true;
		const ownership = new ParadisAgentHookOwnership({ snapshot: async () => available ? tree : undefined });
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		available = false;
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: 231, transcriptPath: CODEX_TRANSCRIPT, at: 2 })).origin, 'invalid');
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 3 })).origin, 'owner');
	});

	test('legacy-only pane keeps working and rebinds after clear (terminal exit)', async () => {
		const ownership = ownershipWith(standardTree());
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 })).origin, 'owner');
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CODEX_TRANSCRIPT, at: 2 })).origin, 'invalid');
		ownership.clear('t');
		assert.strictEqual((await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CODEX_TRANSCRIPT, at: 3 })).origin, 'owner');
	});

	test('a nested child hook arriving before any owner hook does not bootstrap the child as owner', async () => {
		// shared process 再起動直後など、レジストリが空の状態で子のhookが先に届くケース。
		// チェーン最外側のエージェント（ペインのシェルに最も近いclaude）を所有者とする。
		const ownership = ownershipWith(standardTree());
		const first = await ownership.classify({ token: 't', hookPid: 231, transcriptPath: CODEX_TRANSCRIPT, at: 1 });
		assert.deepStrictEqual(first, { origin: 'nested', agentKind: 'codex' });
		const second = await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 2 });
		assert.deepStrictEqual(second, { origin: 'owner', agentKind: 'claude' });
	});

	test('a hook from a vanished pid does not hijack an existing owner', async () => {
		const ownership = ownershipWith(standardTree());
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		// 送信直後にプロセスが消えた（スナップショットに存在しないPID）。
		const result = await ownership.classify({ token: 't', hookPid: 999, transcriptPath: CODEX_TRANSCRIPT, at: 2 });
		assert.strictEqual(result.origin, 'invalid');
	});
});
