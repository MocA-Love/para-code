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

	test('keeps recognizing the regular launch forms of claude and codex', () => {
		assert.deepStrictEqual([
			'codex',
			'env FOO=1 claude',
			'/usr/bin/env -u OLD FOO=1 BAR=2 codex exec',
			'node --require /x/preload.js /usr/local/bin/claude',
			'bun run /x/node_modules/.bin/claude',
			'node /home/user/.npm/_npx/abc/node_modules/.bin/claude',
			'/bin/sh -c claude --resume',
			'/bin/zsh -lc "env FOO=1 claude --resume"',
			'C:\\Users\\user\\.local\\bin\\claude.exe --resume',
			'"C:\\Program Files\\Claude\\claude.exe" --resume',
			'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js"',
			'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\user\\AppData\\Roaming\\npm\\codex.cmd" exec"',
			'pwsh -NoProfile -File C:\\Users\\user\\AppData\\Roaming\\npm\\claude.ps1',
		].map(paradisHookAgentKindFromCommandLine), ['codex', 'claude', 'codex', 'claude', 'claude', 'claude', 'claude', 'claude', 'claude', 'claude', 'codex', 'codex', 'claude']);
	});

	test('recognizes the package entry of npm Claude Code, Para Code launchers and paths with spaces', () => {
		assert.deepStrictEqual([
			// Windows の npm・pnpm は bin のシムを経ずにパッケージの cli.js を実行する。
			'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" --resume',
			'node /home/user/.local/share/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js',
			// ps は argv を引用符なしで空白区切りにする。
			'/bin/sh /Applications/Para Code.app/Contents/Resources/app/resources/paradis/bin/codex --model x',
			'node /Users/John Smith/.npm-global/bin/claude --resume',
			'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\resources\\app\\resources\\paradis\\bin\\paradisCodexPaneLauncher.cjs"',
			'"C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\Para Code.exe" "C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\resources\\app\\resources\\paradis\\bin\\paradisCodexPaneLauncher.cjs"',
		].map(paradisHookAgentKindFromCommandLine), ['claude', 'claude', 'codex', 'claude', 'codex', 'codex']);
	});

	test('does not treat programs that merely pass claude as an argument as agents', () => {
		assert.deepStrictEqual([
			'tmux new-session -s x claude',
			'tmux -L work new -d claude --resume',
			'screen -S x claude',
			'zellij run -- codex',
			'caffeinate -i claude',
			'vim /repo/claude',
			'node -e require("claude")',
			'/bin/zsh -c source /home/user/.claude/shell-snapshots/snapshot.sh && eval \'claude -p x\'',
			'-zsh',
			// パッケージランナーは本体を子として起動するので、ランナー自身は判定しない。
			'npx claude',
			'npx -y @anthropic-ai/claude-code',
			'npm exec claude',
			'bunx claude',
			'bun x claude',
			// スクリプトのパスが拡張子まで揃っていれば、後ろの引数をつながない。
			'node /repo/scripts/run.js logs/claude',
		].map(paradisHookAgentKindFromCommandLine), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	/**
	 * `tmux new-session -s x claude` の再現ツリー。tmux サーバーはデーモン化して launchd の子になり、
	 * 起動したクライアントと同じ起動行を持つ:
	 *   1 (launchd) ← 500 (tmux サーバー) ← 510 (-zsh) ← 520 (claude, 所有者)
	 *     ← 525 (sh) ← 526 (notify script)
	 *   ペイン側: 100 (zsh) ← 150 (tmux クライアント)
	 */
	function tmuxTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[150, proc(150, 100, 'tmux new-session -s x claude')],
			[500, proc(500, 1, 'tmux new-session -s x claude')],
			[510, proc(510, 500, '-zsh')],
			[520, proc(520, 510, 'claude')],
			[525, proc(525, 520, '/bin/sh -c notify')],
			[526, proc(526, 525, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
			[530, proc(530, 520, 'node /home/user/.claude/plugins/cache/openai-codex/codex/1.0.3/scripts/app-server-broker.mjs serve')],
			[540, proc(540, 530, '/opt/codex/vendor/bin/codex app-server')],
			[545, proc(545, 540, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
	}

	test('claude inside a tmux server whose command line contains claude owns the pane', async () => {
		const ownership = ownershipWith(tmuxTree());
		assert.deepStrictEqual([
			await ownership.classify({ token: 't', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 }),
			await ownership.classify({ token: 't', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 2 }),
		], [{ origin: 'owner', agentKind: 'claude' }, { origin: 'owner', agentKind: 'claude' }]);
	});

	test('a nested codex under claude inside tmux still cannot hijack the pane', async () => {
		// d3bae4a490a が防いだ乗っ取り: 子のhookが先に届いても、所有者のあとに届いても nested。
		const ownership = ownershipWith(tmuxTree());
		assert.deepStrictEqual([
			await ownership.classify({ token: 't', hookPid: 545, transcriptPath: CODEX_TRANSCRIPT, at: 1 }),
			await ownership.classify({ token: 't', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 2 }),
			await ownership.classify({ token: 't', hookPid: 545, transcriptPath: CODEX_TRANSCRIPT, at: 3 }),
		], [{ origin: 'nested', agentKind: 'codex' }, { origin: 'owner', agentKind: 'claude' }, { origin: 'nested', agentKind: 'codex' }]);
	});

	test('claude launched through npx owns the pane', async () => {
		// npx の実際の ps は npm が process.title を書き換えた `npm exec …` になる。
		const tree = new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[600, proc(600, 100, 'npm exec @anthropic-ai/claude-code')],
			[610, proc(610, 600, 'node /home/user/.npm/_npx/abc/node_modules/.bin/claude')],
			[615, proc(615, 610, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const ownership = ownershipWith(tree);
		const result = await ownership.classify({ token: 't', hookPid: 615, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		assert.deepStrictEqual(result, { origin: 'owner', agentKind: 'claude' });
	});

	const NPM_CODEX = 'node /Users/user/.npm-global/bin/codex';
	const VENDOR_CODEX = '/Users/user/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex';

	/**
	 * npm 版 codex の実際の親子（`bin/codex.js` が vendor の codex を spawn し、自分は親に残る）:
	 *   100 (zsh) ← 700 (node …/bin/codex, 起動役) ← 710 (vendor codex, 本体) ← 715 (notify)
	 */
	function npmCodexTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[700, proc(700, 100, NPM_CODEX)],
			[710, proc(710, 700, VENDOR_CODEX)],
			[715, proc(715, 710, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
	}

	test('npm codex and the vendor binary it spawns are one agent that owns the pane', async () => {
		const ownership = ownershipWith(npmCodexTree());
		assert.deepStrictEqual([
			await ownership.classify({ token: 't', hookPid: 715, transcriptPath: CODEX_TRANSCRIPT, at: 1 }),
			await ownership.classify({ token: 't', hookPid: 715, transcriptPath: CODEX_TRANSCRIPT, at: 2 }),
		], [{ origin: 'owner', agentKind: 'codex' }, { origin: 'owner', agentKind: 'codex' }]);
	});

	test('codex behind the Para Code pane launcher owns the pane, with and without spaces in the path', async () => {
		const results = [];
		for (const launcherDir of ['/Users/user/src/para-code/resources/paradis/bin', '/Applications/Para Code.app/Contents/Resources/app/resources/paradis/bin']) {
			// ランチャーの sh が app-server と TUI を子として起動し、hook は app-server の配下で動く。
			const tree = new Map([
				[1, proc(1, 0, '/sbin/launchd')],
				[100, proc(100, 1, '/bin/zsh -il')],
				[800, proc(800, 100, `/bin/sh ${launcherDir}/codex`)],
				[810, proc(810, 800, `${NPM_CODEX} app-server --listen unix:///tmp/pcx/pane.sock`)],
				[820, proc(820, 810, `${VENDOR_CODEX} app-server --listen unix:///tmp/pcx/pane.sock`)],
				[825, proc(825, 820, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
				[830, proc(830, 800, `${NPM_CODEX} --remote unix:///tmp/pcx/pane.sock`)],
				[840, proc(840, 830, `${VENDOR_CODEX} --remote unix:///tmp/pcx/pane.sock`)],
			].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
			results.push(await ownershipWith(tree).classify({ token: 't', hookPid: 825, transcriptPath: CODEX_TRANSCRIPT, at: 1 }));
		}
		assert.deepStrictEqual(results, [{ origin: 'owner', agentKind: 'codex' }, { origin: 'owner', agentKind: 'codex' }]);
	});

	test('codex behind the Windows pane launcher owns the pane', async () => {
		const tree = new Map([
			[1, proc(1, 0, 'C:\\WINDOWS\\Explorer.EXE')],
			[100, proc(100, 1, '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo')],
			[900, proc(900, 100, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\resources\\app\\resources\\paradis\\bin\\codex.cmd""')],
			[910, proc(910, 900, '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\resources\\app\\resources\\paradis\\bin\\paradisCodexPaneLauncher.cjs"')],
			[920, proc(920, 910, 'C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe app-server --listen ws://127.0.0.1:0')],
			[925, proc(925, 920, 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\Users\\user\\.para-code\\hooks\\notify-v3.ps1')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const result = await ownershipWith(tree).classify({ token: 't', hookPid: 925, transcriptPath: CODEX_TRANSCRIPT, at: 1 });
		assert.deepStrictEqual(result, { origin: 'owner', agentKind: 'codex' });
	});

	test('claude behind a wrapper script that does not exec owns the pane', async () => {
		const tree = new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[1000, proc(1000, 100, '/bin/sh /Users/user/bin/claude --resume')],
			[1010, proc(1010, 1000, '/Users/user/.local/bin/claude --resume')],
			[1015, proc(1015, 1010, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const result = await ownershipWith(tree).classify({ token: 't', hookPid: 1015, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		assert.deepStrictEqual(result, { origin: 'owner', agentKind: 'claude' });
	});

	test('codex exec started directly by an npm codex stays nested', async () => {
		// d3bae4a490a が防いだ乗っ取りの同種版。本体（vendor の codex）が起動した `codex exec` は、
		// 間にシェルが無くても本体の形で止まるので、所有者の codex と1体にはならない。
		const tree = npmCodexTree();
		tree.set(740, proc(740, 710, `${NPM_CODEX} exec task`));
		tree.set(750, proc(750, 740, `${VENDOR_CODEX} exec task`));
		tree.set(755, proc(755, 750, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh'));
		const CODEX_TRANSCRIPT_2 = '/home/user/.codex/sessions/2026/07/16/rollout-2026-07-16T16-06-02-def.jsonl';
		const childFirst = ownershipWith(tree);
		const ownerFirst = ownershipWith(tree);
		assert.deepStrictEqual([
			await childFirst.classify({ token: 't', hookPid: 755, transcriptPath: CODEX_TRANSCRIPT_2, at: 1 }),
			await childFirst.classify({ token: 't', hookPid: 715, transcriptPath: CODEX_TRANSCRIPT, at: 2 }),
			await ownerFirst.classify({ token: 't', hookPid: 715, transcriptPath: CODEX_TRANSCRIPT, at: 1 }),
			await ownerFirst.classify({ token: 't', hookPid: 755, transcriptPath: CODEX_TRANSCRIPT_2, at: 2 }),
		], [
			{ origin: 'nested', agentKind: 'codex' },
			{ origin: 'owner', agentKind: 'codex' },
			{ origin: 'owner', agentKind: 'codex' },
			{ origin: 'nested', agentKind: 'codex' },
		]);
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
