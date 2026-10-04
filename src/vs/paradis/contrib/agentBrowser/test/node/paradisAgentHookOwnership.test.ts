/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisHookProcessInfo, ParadisAgentHookOwnership, paradisHookAgentKindFromCommandLine, paradisIsClaudeBackgroundHostCommand } from '../../node/paradisAgentHookOwnership.js';

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
			'node /Users/John Smith/.npm-global/bin/codex --model x',
			'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\resources\\app\\resources\\paradis\\bin\\paradisCodexPaneLauncher.cjs"',
			'"C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\Para Code.exe" "C:\\Users\\user\\AppData\\Local\\Programs\\Para Code\\resources\\app\\resources\\paradis\\bin\\paradisCodexPaneLauncher.cjs"',
		].map(paradisHookAgentKindFromCommandLine), ['claude', 'claude', 'codex', 'codex', 'codex', 'codex']);
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
			// スクリプトのパスが拡張子まで揃っている・実在するファイル・引数が相対パスなら、後ろの引数をつながない。
			'node /repo/scripts/run.js logs/claude',
			`node ${process.execPath} scripts/claude`,
			'bash /Users/u/bin/run ./codex',
			'bash /Users/u/bin/run ../bin/claude',
		].map(paradisHookAgentKindFromCommandLine), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	/**
	 * `tmux new-session -s x claude` の再現ツリー（実機の ps と同じ形）。tmux サーバーはデーモン化して
	 * launchd の子になり、起動したクライアントと同じ起動行を持つ。claude はサーバーの直下:
	 *   1 (launchd) ← 500 (tmux サーバー) ← 520 (claude, 所有者) ← 525 (sh) ← 526 (notify script)
	 *   ペイン側: 100 (zsh) ← 150 (tmux クライアント)
	 */
	function tmuxTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[150, proc(150, 100, 'tmux new-session -s x claude')],
			[500, proc(500, 1, 'tmux new-session -s x claude')],
			[520, proc(520, 500, 'claude')],
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

	test('an agent that launched Para Code itself does not own the panes', async () => {
		// 外側の claude（900）から Para Code（910 main ← 920 shared process）を起動し、ペイン（100）の中で claude（200）を動かす
		const tree = new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[890, proc(890, 1, '/bin/zsh -il')],
			[900, proc(900, 890, 'claude')],
			[910, proc(910, 900, '/Applications/Para Code.app/Contents/MacOS/Electron')],
			[920, proc(920, 910, 'Para Code Helper --type=utility')],
			[930, proc(930, 910, 'Para Code Helper --type=utility pty host')],
			[100, proc(100, 930, '/bin/zsh -il')],
			[200, proc(200, 100, 'claude')],
			[205, proc(205, 200, '/bin/sh -c notify')],
			[206, proc(206, 205, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const insideParaCode = new ParadisAgentHookOwnership({ snapshot: async () => tree }, 920);
		const withoutSelf = new ParadisAgentHookOwnership({ snapshot: async () => tree }, 99_999);
		assert.deepStrictEqual([
			await insideParaCode.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 }),
			await insideParaCode.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 2 }),
			// Para Code 自身がプロセス表に無ければ、これまでどおり（外側の claude が所有者になる）
			await withoutSelf.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 }),
		], [{ origin: 'owner', agentKind: 'claude' }, { origin: 'owner', agentKind: 'claude' }, { origin: 'nested', agentKind: 'claude' }]);
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

	/**
	 * Windows の npm 版 Claude Code（ps が `process.title` を反映しないので `node …\cli.js` のまま見える）:
	 *   100 (pwsh) ← 200 (cmd /c claude.cmd) ← 210 (node cli.js, 所有者の本体) ← 215 (notify)
	 */
	function windowsNpmClaudeTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, 'C:\\WINDOWS\\Explorer.EXE')],
			[100, proc(100, 1, '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo')],
			[200, proc(200, 100, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c ""C:\\Users\\user\\AppData\\Roaming\\npm\\claude.cmd""')],
			[210, proc(210, 200, WINDOWS_NPM_CLAUDE)],
			[215, proc(215, 210, 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\Users\\user\\.para-code\\hooks\\notify-v3.ps1')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
	}
	const WINDOWS_NPM_CLAUDE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js"';

	test('a claude started by Windows npm Claude Code stays nested however it is started', async () => {
		const results = [];
		for (const launch of [
			// Node の `shell: true`（cmd.exe）経由。cmd は claude.cmd を同じプロセスで実行し、node を子にする。
			[[300, 210, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "claude -p summarize"'], [310, 300, `${WINDOWS_NPM_CLAUDE} -p summarize`]],
			// Git Bash 経由。npm の sh シムは exec で node に置き換わる。
			[[300, 210, '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" -c "claude -p summarize"'], [310, 300, `${WINDOWS_NPM_CLAUDE} -p summarize`]],
			// 本体が直接 spawn。
			[[310, 210, `${WINDOWS_NPM_CLAUDE} -p summarize`]],
		] as [number, number, string][][]) {
			const tree = windowsNpmClaudeTree();
			for (const [pid, ppid, command] of launch) {
				tree.set(pid, proc(pid, ppid, command));
			}
			tree.set(315, proc(315, 310, 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\Users\\user\\.para-code\\hooks\\notify-v3.ps1'));
			const ownership = ownershipWith(tree);
			results.push([
				(await ownership.classify({ token: 't', hookPid: 215, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 })).origin,
				(await ownership.classify({ token: 't', hookPid: 315, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 })).origin,
				(await ownership.classify({ token: 't', hookPid: 215, transcriptPath: CLAUDE_TRANSCRIPT, at: 3 })).origin,
			]);
		}
		assert.deepStrictEqual(results, [['owner', 'nested', 'owner'], ['owner', 'nested', 'owner'], ['owner', 'nested', 'owner']]);
	});

	/**
	 * 2つのペインで共有した tmux サーバー（実機の ps と同じ形）。サーバーの環境はペイン A のもので、
	 * ペイン B から作ったセッション y の claude もペイン A のトークンでhookを送る:
	 *   ペイン A: 100 (zsh) ← 150 (tmux クライアント x)
	 *   ペイン B: 200 (zsh) ← 250 (tmux クライアント y)
	 *   1 (launchd) ← 500 (tmux サーバー) ← 520 (claude x) ← 526 (notify)
	 *                                     ← 620 (claude y) ← 626 (notify)
	 */
	function sharedTmuxTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[150, proc(150, 100, 'tmux new-session -s x claude')],
			[200, proc(200, 1, '/bin/zsh -il')],
			[250, proc(250, 200, 'tmux new-session -s y claude')],
			[500, proc(500, 1, 'tmux new-session -s x claude')],
			[520, proc(520, 500, 'claude')],
			[526, proc(526, 520, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
			[620, proc(620, 500, 'claude')],
			[626, proc(626, 620, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
	}

	test('known limitation: a claude from another pane sharing the tmux server succeeds the pane owner', async () => {
		// 既知の制限（NOTES.md「hook 所有者判定の既知の制限」）: 共有サーバーの y はペイン A の
		// トークンでhookを送る。x が生きている間は invalid だが、x が終わると y が後継になり、
		// y の状態がペイン A に出る。後継をペインのシェルの配下に絞ると、同じペインで tmux の
		// エージェントを起動し直したときに状態が出なくなる（下のテスト）ので、絞っていない。
		const tree = sharedTmuxTree();
		const ownership = ownershipWith(tree);
		const origins = [
			(await ownership.classify({ token: 'a', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 })).origin,
			(await ownership.classify({ token: 'a', hookPid: 626, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 })).origin,
		];
		// x の claude が終わる。
		tree.delete(520);
		tree.delete(526);
		tree.delete(150);
		origins.push((await ownership.classify({ token: 'a', hookPid: 626, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 3 })).origin);
		assert.deepStrictEqual(origins, ['owner', 'invalid', 'owner']);
	});

	test('an agent restarted in the same pane through tmux succeeds the pane owner', async () => {
		// 実機で確かめた5つの形。どれもペインのシェル (100) は hook の祖先にいない（直接起動の前の所有者を除く）。
		type Process = [pid: number, ppid: number, command: string];
		const cases: { readonly name: string; readonly before: Process[]; readonly after: Process[] }[] = [
			{
				name: 'same tmux shell',
				before: [[150, 100, 'tmux -L d new-session -s w'], [500, 1, 'tmux -L d new-session -s w'], [510, 500, '-zsh'], [520, 510, 'claude']],
				after: [[150, 100, 'tmux -L d new-session -s w'], [500, 1, 'tmux -L d new-session -s w'], [510, 500, '-zsh'], [530, 510, 'claude']],
			},
			{
				name: 'another window of the same session',
				before: [[150, 100, 'tmux -L d new-session -s w'], [500, 1, 'tmux -L d new-session -s w'], [510, 500, '-zsh'], [520, 510, 'claude']],
				after: [[150, 100, 'tmux -L d new-session -s w'], [500, 1, 'tmux -L d new-session -s w'], [510, 500, '-zsh'], [610, 500, '-zsh'], [530, 610, 'claude']],
			},
			{
				name: 'recreated session',
				before: [[150, 100, 'tmux -L d new-session -s w'], [500, 1, 'tmux -L d new-session -s w'], [510, 500, '-zsh'], [520, 510, 'claude']],
				after: [[160, 100, 'tmux -L d new-session -s w2'], [700, 1, 'tmux -L d new-session -s w2'], [710, 700, '-zsh'], [530, 710, 'claude']],
			},
			{
				name: 'tmux new-session -s x2 claude after -s x claude',
				before: [[150, 100, 'tmux new-session -s x claude'], [500, 1, 'tmux new-session -s x claude'], [520, 500, 'claude']],
				after: [[160, 100, 'tmux new-session -s x2 claude'], [800, 1, 'tmux new-session -s x2 claude'], [530, 800, 'claude']],
			},
			{
				name: 'tmux after a directly started claude',
				before: [[520, 100, 'claude']],
				after: [[160, 100, 'tmux new-session -s x claude'], [900, 1, 'tmux new-session -s x claude'], [530, 900, 'claude']],
			},
		];
		const results: [string, string[]][] = [];
		for (const { name, before, after } of cases) {
			const base: Process[] = [[1, 0, '/sbin/launchd'], [100, 1, '/bin/zsh -il']];
			const toTree = (processes: Process[]) => new Map(processes.map(([pid, ppid, command]) => [pid, proc(pid, ppid, command)] as [number, IParadisHookProcessInfo]));
			const tree = toTree([...base, ...before, [526, 520, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh']]);
			const ownership = new ParadisAgentHookOwnership({ snapshot: async () => tree });
			const origins = [(await ownership.classify({ token: 'a', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 })).origin];
			// 前の所有者が終わり、同じペインで起動し直す。
			tree.clear();
			for (const [pid, info] of toTree([...base, ...after, [536, 530, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh']])) {
				tree.set(pid, info);
			}
			origins.push((await ownership.classify({ token: 'a', hookPid: 536, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 })).origin);
			results.push([name, origins]);
		}
		assert.deepStrictEqual(results, cases.map(({ name }) => [name, ['owner', 'owner']]));
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

	/**
	 * Claude Code 2.1.289 の `/fork` で実測した形を写したツリー:
	 *   100 (zsh, ペインのシェル) ← 200 (claude, 所有者) ← 500 (`claude daemon run`)
	 *     ← 510 (`claude bg-pty-host`) ← 520 (`claude bg-spare`, 分岐先の会話) ← 521 (notify script)
	 * daemon は所有者の子として起き、所有者の環境（ペインの token）を持ち続ける。
	 */
	function forkTree(): Map<number, IParadisHookProcessInfo> {
		const tree = standardTree();
		tree.set(500, proc(500, 200, '/home/user/.local/bin/claude daemon run --origin transient --spawned-by {"label":"claude","cwd":"/repo","pid":200}'));
		tree.set(510, proc(510, 500, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/x/spare/a.pty.sock 200 50 -- /home/user/.local/share/claude/versions/2.1.289 --bg-spare /tmp/cc-daemon-501/x/spare/a.claim.sock'));
		tree.set(520, proc(520, 510, 'claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/a.claim.sock'));
		tree.set(521, proc(521, 520, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		return tree;
	}

	test('recognizes the processes of the Claude Code daemon', () => {
		assert.deepStrictEqual([
			'/home/user/.local/bin/claude daemon run --origin transient',
			'claude bg-pty-host --bg-pty-host /tmp/a.pty.sock 200 50 -- /x/versions/2.1.289 --bg-spare /tmp/a.claim.sock',
			'claude bg-spare --bg-spare /tmp/a.claim.sock',
			// argv[0] が版のディレクトリのパスに見える形
			'/home/user/.local/share/claude/versions/2.1.289 --bg-spare /tmp/a.claim.sock',
			'claude',
			'claude --resume 11111111',
			'claude attach 52a3701d',
			'claude daemon status',
			'/bin/zsh -il',
			// プロンプトや後ろの引数に同じ綴りが出るだけのもの
			'claude "--bg-spare について"',
			'claude --resume 11111111 --bg-spare',
			'node /x/claude-helper.js run daemon run',
			// node 経由の起動（npm 版など）。claude のスクリプトの次の語で見る
			'node /x/claude bg-spare --bg-spare s',
			'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js daemon run',
			'env FOO=1 node --require /x/preload.js /x/claude bg-pty-host --bg-pty-host s',
			'node /x/claude "--bg-spare について"',
			'node /x/other.js bg-spare',
		].map(paradisIsClaudeBackgroundHostCommand), [true, true, true, true, false, false, false, false, false, false, false, false, true, true, true, false, false]);
	});

	test('a hook from a forked session in the daemon is neither nested nor the owner, before and after the pane owner exits', async () => {
		const tree = forkTree();
		const ownership = ownershipWith(tree);
		const owner = await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const whileOwnerAlive = await ownership.classify({ token: 't', hookPid: 521, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 });
		// 所有者の claude が終わると daemon は launchd の子になる。daemon を後継の所有者にしない。
		tree.delete(200);
		tree.delete(205);
		tree.delete(206);
		tree.set(500, proc(500, 1, '/home/user/.local/bin/claude daemon run --origin transient'));
		const afterOwnerExit = await ownership.classify({ token: 't', hookPid: 521, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 3 });
		// 同じペインで claude を起動し直したら、それが所有者になる（daemon が所有者の席を取っていない）。
		tree.set(300, proc(300, 100, 'claude'));
		tree.set(305, proc(305, 300, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh'));
		const restarted = await ownership.classify({ token: 't', hookPid: 305, transcriptPath: CLAUDE_TRANSCRIPT, at: 4 });
		assert.deepStrictEqual([owner, whileOwnerAlive, afterOwnerExit, restarted], [
			{ origin: 'owner', agentKind: 'claude' },
			{ origin: 'background', agentKind: 'claude' },
			{ origin: 'background', agentKind: 'claude' },
			{ origin: 'owner', agentKind: 'claude' },
		]);
	});

	test('a real nested claude under the pane owner stays nested next to a running daemon', async () => {
		const tree = forkTree();
		tree.set(240, proc(240, 200, 'node /usr/local/bin/claude -p "sub"'));
		tree.set(241, proc(241, 240, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh'));
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const result = await ownership.classify({ token: 't', hookPid: 241, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 });
		assert.deepStrictEqual(result, { origin: 'nested', agentKind: 'claude' });
	});
});
