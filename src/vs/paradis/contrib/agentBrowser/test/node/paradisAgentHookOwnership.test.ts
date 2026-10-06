/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisClaudeJob } from '../../node/paradisClaudeJobNames.js';
import { IParadisHookProcessInfo, ParadisAgentHookOwnership, paradisClaudeAttachNameFromCommandLine, paradisClaudeAttachTargetFromCommandLine, paradisHookAgentKindFromCommandLine, paradisIsClaudeBackgroundHostCommand, paradisIsCodexPluginCommand } from '../../node/paradisAgentHookOwnership.js';

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
			// ペインのシェル (100) を渡しても、tmux のサーバー配下は後継の絞り込みから外れる。
			const origins = [(await ownership.classify({ token: 'a', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 1, paneShellPid: 100 })).origin];
			// 前の所有者が終わり、同じペインで起動し直す。
			tree.clear();
			for (const [pid, info] of toTree([...base, ...after, [536, 530, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh']])) {
				tree.set(pid, info);
			}
			origins.push((await ownership.classify({ token: 'a', hookPid: 536, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2, paneShellPid: 100 })).origin);
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

	test('records which branch rejected a hook for the drop diagnostics', async () => {
		const tree = standardTree();
		tree.set(400, proc(400, 100, '/opt/codex/vendor/bin/codex'));
		tree.set(401, proc(401, 400, '/bin/sh /home/user/.para-code/hooks/notify-v3.sh'));
		const ownership = new ParadisAgentHookOwnership({ snapshot: async () => tree, lastSnapshotAt: () => undefined });
		await ownership.classify({ token: 'pid', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		await ownership.classify({ token: 'remote', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const results = [
			await ownership.classify({ token: 'pid', hookPid: 401, transcriptPath: CODEX_TRANSCRIPT, at: 2 }),
			await ownership.classify({ token: 'pid', hookPid: 999, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 3 }),
			await ownership.classify({ token: 'remote', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 4 }),
		].map(result => [result.origin, result.rejection]);
		assert.deepStrictEqual(results, [
			['invalid', { identityLoss: undefined, ownerPinnedBy: 'pid', ownerTranscriptPath: CLAUDE_TRANSCRIPT, ownerAt: 1, snapshotAgeMs: undefined }],
			['invalid', { identityLoss: 'pid-not-in-snapshot', ownerPinnedBy: 'pid', ownerTranscriptPath: CLAUDE_TRANSCRIPT, ownerAt: 1, snapshotAgeMs: undefined }],
			['invalid', { identityLoss: 'no-pid', ownerPinnedBy: 'transcript', ownerTranscriptPath: CLAUDE_TRANSCRIPT, ownerAt: 1, snapshotAgeMs: undefined }],
		]);
	});

	test('tells a pid outside the panes apart from a pid missing in the snapshot, and survives a failing snapshot age', async () => {
		const tree = standardTree();
		// Para Code 自身をペインのシェル (100) とみなす。100 から出た hook の祖先は全部ペインの外になる。
		const ownership = new ParadisAgentHookOwnership({ snapshot: async () => tree, lastSnapshotAt: () => { throw new Error('boom'); } }, 100);
		await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const results = [
			await ownership.classify({ token: 't', hookPid: 100, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2 }),
			await ownership.classify({ token: 't', hookPid: 999, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 3 }),
		].map(result => [result.origin, result.rejection?.identityLoss, result.rejection?.snapshotAgeMs]);
		assert.deepStrictEqual(results, [['invalid', 'pid-outside-panes', undefined], ['invalid', 'pid-not-in-snapshot', undefined]]);
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

	/**
	 * `claude attach <id>` のペイン（2.1.289 で実測した形。daemon は attach が起こし、attach の子になる）と、
	 * Claude Code の Codex plugin が detached で起動した `codex app-server`（親は PID 1）:
	 *   100 (zsh, ペインのシェル) ← 300 (`claude attach 11111111`) ← 400 (`claude daemon run`)
	 *     ← 410 (`claude bg-pty-host`) ← 420 (`claude bg-spare`, attach が見ている会話) ← 421 (notify script)
	 *     ← 430 (`claude bg-pty-host`) ← 440 (`claude bg-spare`, 別の会話) ← 441 (notify script)
	 *   1 ← 600 (node broker) ← 610 (node codex) ← 620 (codex vendor app-server) ← 621 (notify script)
	 */
	const ATTACHED_SESSION_ID = '11111111-1111-1111-1111-111111111111';
	function attachTree(): Map<number, IParadisHookProcessInfo> {
		return new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[300, proc(300, 100, 'claude attach 11111111')],
			[400, proc(400, 300, '/home/user/.local/bin/claude daemon run --origin transient --spawned-by {"label":"claude","cwd":"/repo","pid":300}')],
			[410, proc(410, 400, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/x/spare/a.pty.sock 200 50 -- /home/user/.local/share/claude/versions/2.1.289 --bg-spare /tmp/cc-daemon-501/x/spare/a.claim.sock')],
			[420, proc(420, 410, 'claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/a.claim.sock')],
			[421, proc(421, 420, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
			[430, proc(430, 400, 'claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/x/spare/b.pty.sock 200 50 -- /home/user/.local/share/claude/versions/2.1.289 --bg-spare /tmp/cc-daemon-501/x/spare/b.claim.sock')],
			[440, proc(440, 430, 'claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/b.claim.sock')],
			[441, proc(441, 440, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
			[600, proc(600, 1, 'node /home/user/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs serve --cwd /repo')],
			[610, proc(610, 600, 'node /home/user/.npm-global/bin/codex app-server')],
			[620, proc(620, 610, '/home/user/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex app-server')],
			[621, proc(621, 620, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
	}

	test('reads the target of claude attach', () => {
		assert.deepStrictEqual([
			'claude attach d527839f',
			'/home/user/.local/bin/claude attach D527839F-B586-4387-A89D-A3D7C5616DAB',
			'node /x/claude attach d527839f',
			'claude attach',
			'claude attach abc',
			'claude --resume d527839f',
			'tmux new-session claude attach d527839f',
		].map(paradisClaudeAttachTargetFromCommandLine), ['d527839f', 'd527839f-b586-4387-a89d-a3d7c5616dab', 'd527839f', undefined, undefined, undefined, undefined]);
	});

	test('claude attach owns the pane through the daemon-hosted session it shows, until it exits', async () => {
		const tree = attachTree();
		const ownership = ownershipWith(tree);
		const at = (n: number) => ({ token: 't', at: n, paneShellPid: 100 });
		const results = [
			// attach が見ている会話の hook は所有者
			await ownership.classify({ ...at(1), hookPid: 421, transcriptPath: CLAUDE_TRANSCRIPT, sessionId: ATTACHED_SESSION_ID }),
			// 同じ daemon の別の会話は background のまま
			await ownership.classify({ ...at(2), hookPid: 441, transcriptPath: CLAUDE_TRANSCRIPT_2, sessionId: '22222222-2222-2222-2222-222222222222' }),
			// detached の codex app-server は所有者を奪えない
			(await ownership.classify({ ...at(3), hookPid: 621, transcriptPath: CODEX_TRANSCRIPT })).origin,
			// /clear で会話 id が変わっても、同じ daemon のプロセスからなら所有者
			await ownership.classify({ ...at(4), hookPid: 421, transcriptPath: CLAUDE_TRANSCRIPT_2, sessionId: '22222222-2222-2222-2222-222222222222' }),
		];
		// attach の会話の中で起動した codex は子エージェント
		tree.set(425, proc(425, 420, '/opt/codex/vendor/bin/codex exec'));
		tree.set(426, proc(426, 425, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		results.push(await ownership.classify({ ...at(5), hookPid: 426, transcriptPath: CODEX_TRANSCRIPT }));
		// attach が終わる（daemon は launchd の子になる）。会話は background に戻り、detached の codex も後継になれない。
		tree.delete(300);
		tree.set(400, proc(400, 1, '/home/user/.local/bin/claude daemon run --origin transient'));
		results.push(
			await ownership.classify({ ...at(6), hookPid: 421, transcriptPath: CLAUDE_TRANSCRIPT, sessionId: ATTACHED_SESSION_ID }),
			(await ownership.classify({ ...at(7), hookPid: 621, transcriptPath: CODEX_TRANSCRIPT })).origin,
		);
		// 同じペインで claude を起動し直したら、それが所有者
		tree.set(700, proc(700, 100, 'claude'));
		tree.set(701, proc(701, 700, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		results.push(await ownership.classify({ ...at(8), hookPid: 701, transcriptPath: CLAUDE_TRANSCRIPT }));
		assert.deepStrictEqual(results, [
			{ origin: 'owner', agentKind: 'claude' },
			{ origin: 'background', agentKind: 'claude' },
			'invalid',
			{ origin: 'owner', agentKind: 'claude' },
			{ origin: 'nested', agentKind: 'codex' },
			{ origin: 'background', agentKind: 'claude' },
			'invalid',
			{ origin: 'owner', agentKind: 'claude' },
		]);
	});

	test('a claude attach in another pane does not make the daemon session the owner of this pane', async () => {
		const tree = attachTree();
		// attach はペイン 150 のシェルの下にいる。hook はこのペイン（シェル 100）の token で届く。
		tree.set(150, proc(150, 1, '/bin/zsh -il'));
		tree.set(300, proc(300, 150, 'claude attach 11111111'));
		const ownership = ownershipWith(tree);
		const result = await ownership.classify({ token: 't', hookPid: 421, transcriptPath: CLAUDE_TRANSCRIPT, sessionId: ATTACHED_SESSION_ID, at: 1, paneShellPid: 100 });
		assert.deepStrictEqual(result, { origin: 'background', agentKind: 'claude' });
	});

	test('reads the name of claude attach <name>', () => {
		assert.deepStrictEqual([
			paradisClaudeAttachNameFromCommandLine('claude attach Fix Login', 'darwin'),
			paradisClaudeAttachNameFromCommandLine('/home/user/.local/bin/claude attach  ログイン修正 ', 'linux'),
			paradisClaudeAttachNameFromCommandLine('"C:\\Users\\user\\.local\\bin\\claude.exe" attach "Fix Login"', 'win32'),
			// POSIX の ps では打った引用符は消える。残っているなら名前の一部
			paradisClaudeAttachNameFromCommandLine('claude attach "quoted"', 'darwin'),
			// id の形は名前としては読まない（paradisClaudeAttachTargetFromCommandLine が読む）
			paradisClaudeAttachNameFromCommandLine('claude attach d527839f', 'darwin'),
			paradisClaudeAttachNameFromCommandLine('claude attach cafe', 'darwin'),
			paradisClaudeAttachNameFromCommandLine('claude attach', 'darwin'),
			paradisClaudeAttachNameFromCommandLine('claude --resume fix', 'darwin'),
		], ['fix login', 'ログイン修正', 'fix login', '"quoted"', undefined, undefined, undefined, undefined]);
	});

	test('claude attach <name> owns the pane only when the name picks exactly one background session of that conversation', async () => {
		const jobs: IParadisClaudeJob[] = [
			{ shortId: '11111111', sessionId: ATTACHED_SESSION_ID, name: 'ログイン修正 "v2"' },
			{ shortId: '22222222', sessionId: '22222222-2222-2222-2222-222222222222', name: 'Fix login page' },
			{ shortId: '33333333', sessionId: '33333333-3333-3333-3333-333333333333', name: 'Fix login page' },
		];
		const classify = async (attachCommand: string, sessionId: string, transcriptPath: string, paneOfAttach = 100) => {
			const tree = attachTree();
			tree.set(150, proc(150, 1, '/bin/zsh -il'));
			tree.set(300, proc(300, paneOfAttach, attachCommand));
			const ownership = new ParadisAgentHookOwnership({ snapshot: async () => tree }, undefined, undefined, async () => jobs);
			return (await ownership.classify({ token: 't', hookPid: 421, transcriptPath, sessionId, at: 1, paneShellPid: 100 })).origin;
		};
		assert.deepStrictEqual([
			// 名前の一部（日本語・引用符入り）で 1 つに決まる
			await classify('claude attach ログイン修正 "v2', ATTACHED_SESSION_ID, CLAUDE_TRANSCRIPT),
			// 決まった job と別の会話の hook は当てない
			await classify('claude attach ログイン修正', '22222222-2222-2222-2222-222222222222', CLAUDE_TRANSCRIPT_2),
			// 同じ名前が 2 つ（CLI も attach しない）
			await classify('claude attach Fix login page', '22222222-2222-2222-2222-222222222222', CLAUDE_TRANSCRIPT_2),
			// 当たる job が無い
			await classify('claude attach nothing here', ATTACHED_SESSION_ID, CLAUDE_TRANSCRIPT),
			// ほかのペインの attach は当てない
			await classify('claude attach ログイン修正', ATTACHED_SESSION_ID, CLAUDE_TRANSCRIPT, 150),
		], ['owner', 'background', 'background', 'background', 'background']);
	});

	test('a detached codex outside the pane cannot take over a pane whose owner has no pid', async () => {
		// Para Code の再起動直後や控えの流し直しで、所有者が transcript だけで記録された状態。
		const tree = attachTree();
		tree.set(200, proc(200, 100, 'claude'));
		tree.set(206, proc(206, 200, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		const ownership = ownershipWith(tree);
		await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const outside = await ownership.classify({ token: 't', hookPid: 621, transcriptPath: CODEX_TRANSCRIPT, at: 2, paneShellPid: 100 });
		const inside = await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 3, paneShellPid: 100 });
		const afterOwner = await ownership.classify({ token: 't', hookPid: 621, transcriptPath: CODEX_TRANSCRIPT, at: 4, paneShellPid: 100 });
		// ペインのシェルが分からない（接続先・同期前）ときはこれまでどおり後継にする。
		const fallback = ownershipWith(tree);
		await fallback.classify({ token: 't', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const withoutShell = await fallback.classify({ token: 't', hookPid: 621, transcriptPath: CODEX_TRANSCRIPT, at: 2 });
		assert.deepStrictEqual([outside, inside, afterOwner.origin, withoutShell], [
			{ origin: 'invalid', agentKind: 'codex', rejection: { identityLoss: undefined, ownerPinnedBy: 'transcript', ownerTranscriptPath: CLAUDE_TRANSCRIPT, ownerAt: 1, snapshotAgeMs: undefined, outsidePane: true } },
			{ origin: 'owner', agentKind: 'claude' },
			'invalid',
			{ origin: 'owner', agentKind: 'codex' },
		]);
	});

	test('recognizes the processes of the Claude Code Codex plugin', () => {
		assert.deepStrictEqual([
			paradisIsCodexPluginCommand('/usr/local/bin/node /home/user/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs serve --endpoint unix:/tmp/cxc/broker.sock --cwd /repo'),
			paradisIsCodexPluginCommand('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\user\\.claude\\plugins\\cache\\openai-codex\\codex\\1.0.6\\scripts\\codex-companion.mjs" task-worker --cwd C:\\repo'),
			paradisIsCodexPluginCommand('node /opt/plugins/codex/scripts/app-server-broker.mjs serve'),
			paradisIsCodexPluginCommand('/opt/codex/vendor/bin/codex app-server'),
			paradisIsCodexPluginCommand('/home/user/.codex/plugins/cache/openai-curated-remote/codex-security/0.1.31/mcp/server.mjs --stdio'),
			paradisIsCodexPluginCommand('node.exe'),
		], [true, true, true, false, false, false]);
	});

	/**
	 * ペインの外の codex（親は PID 1）。所有者は pid の無い記録（Para Code の再起動直後など）で、後継を決める場面。
	 *   1 ← 800 (`launcher`) ← 810 (codex vendor app-server) ← 811 (notify script)
	 */
	async function successorOutsidePane(launcher: string | undefined, rolloutHead: string | undefined): Promise<string> {
		const tree = attachTree();
		tree.set(200, proc(200, 100, 'claude'));
		tree.set(206, proc(206, 200, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		const codexParent = launcher !== undefined ? 800 : 1;
		if (launcher !== undefined) {
			tree.set(800, proc(800, 1, launcher));
		}
		tree.set(810, proc(810, codexParent, '/opt/codex/vendor/bin/codex app-server --listen unix:///tmp/codex/app-server.sock'));
		tree.set(811, proc(811, 810, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		const reads: string[] = [];
		const ownership = new ParadisAgentHookOwnership({ snapshot: async () => tree }, process.pid, async path => {
			reads.push(path);
			return rolloutHead;
		});
		await ownership.classify({ token: 't', hookPid: undefined, transcriptPath: CLAUDE_TRANSCRIPT, at: 1 });
		const first = await ownership.classify({ token: 't', hookPid: 811, transcriptPath: CODEX_TRANSCRIPT, at: 2, paneShellPid: 100 });
		return `${first.origin}${first.rejection?.outsidePane === true ? ' (outside pane)' : ''}, reads ${reads.length}`;
	}

	test('only a codex started by the Claude Code Codex plugin is kept from succeeding the pane owner from outside the pane', async () => {
		const sharedDaemonMeta = '{"timestamp":"2026-10-06T00:00:00.000Z","type":"session_meta","payload":{"id":"x","originator":"codex_cli_rs","source":"cli"}}\n{"type":"event_msg"}';
		const pluginMeta = '{"timestamp":"2026-10-06T00:00:00.000Z","type":"session_meta","payload":{"id":"x","originator":"Claude Code","source":"vscode"}}\n{"type":"event_msg"}';
		assert.deepStrictEqual([
			// 素の codex の共有 daemon: 従来どおり後継になれる
			await successorOutsidePane(undefined, sharedDaemonMeta),
			// rollout がまだ無い: 判定できないので後継にする
			await successorOutsidePane(undefined, undefined),
			// 祖先に plugin の broker がいる: rollout を読まずに捨てる
			await successorOutsidePane('node /home/user/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/app-server-broker.mjs serve --cwd /repo', sharedDaemonMeta),
			// 起動行が取れない（Windows で CommandLine が空になり Name だけが見える）: rollout の originator で捨てる
			await successorOutsidePane('node.exe', pluginMeta),
		], [
			'owner, reads 1',
			'owner, reads 1',
			'invalid (outside pane), reads 0',
			'invalid (outside pane), reads 1',
		]);
	});

	test('a session_meta line cut before originator is read again on the next hook', async () => {
		const tree = attachTree();
		tree.set(810, proc(810, 1, '/opt/codex/vendor/bin/codex app-server --listen unix:///tmp/codex/app-server.sock'));
		tree.set(811, proc(811, 810, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		const heads = [
			'{"timestamp":"2026-10-06T00:00:00.000Z","type":"session_meta","payload":{"id":"x","forked_from_id":null,"times',
			'{"timestamp":"2026-10-06T00:00:00.000Z","type":"session_meta","payload":{"id":"x","originator":"Claude Code","source":"vscode"}}\n',
		];
		let reads = 0;
		const ownership = new ParadisAgentHookOwnership({ snapshot: async () => tree }, process.pid, async () => heads[reads++]);
		const first = await ownership.classify({ token: 't', hookPid: 811, transcriptPath: CODEX_TRANSCRIPT, at: 1, paneShellPid: 100 });
		const second = await ownership.classify({ token: 'u', hookPid: 811, transcriptPath: CODEX_TRANSCRIPT, at: 2, paneShellPid: 100 });
		assert.deepStrictEqual([first.origin, second.origin, reads], ['owner', 'invalid', 2]);
	});

	test('codex started by hand inside claude stays nested, and codex started after claude exits owns the pane', async () => {
		const tree = standardTree();
		tree.set(250, proc(250, 200, '/bin/zsh -c codex'));
		tree.set(260, proc(260, 250, '/opt/codex/vendor/bin/codex'));
		tree.set(261, proc(261, 260, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		const ownership = ownershipWith(tree);
		const results = [
			await ownership.classify({ token: 't', hookPid: 206, transcriptPath: CLAUDE_TRANSCRIPT, at: 1, paneShellPid: 100 }),
			await ownership.classify({ token: 't', hookPid: 261, transcriptPath: CODEX_TRANSCRIPT, at: 2, paneShellPid: 100 }),
		];
		for (const pid of [200, 205, 206, 210, 220, 230, 231, 250, 260, 261]) {
			tree.delete(pid);
		}
		tree.set(270, proc(270, 100, '/opt/codex/vendor/bin/codex'));
		tree.set(271, proc(271, 270, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh'));
		results.push(await ownership.classify({ token: 't', hookPid: 271, transcriptPath: CODEX_TRANSCRIPT, at: 3, paneShellPid: 100 }));
		assert.deepStrictEqual(results, [
			{ origin: 'owner', agentKind: 'claude' },
			{ origin: 'nested', agentKind: 'codex' },
			{ origin: 'owner', agentKind: 'codex' },
		]);
	});

	test('the pane process itself can own the pane (exec claude, exec claude attach)', async () => {
		// `exec claude` でシェルが置き換わった、またはペインの最初のプロセスがエージェントのとき、発信元はペインのプロセスそのもの。
		const tree = new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, 'claude')],
			[106, proc(106, 100, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const exec = await ownershipWith(tree).classify({ token: 't', hookPid: 106, transcriptPath: CLAUDE_TRANSCRIPT, at: 1, paneShellPid: 100 });
		// `exec claude attach <id>` でも、ペインのプロセスそのものが attach になる。
		const attach = attachTree();
		attach.delete(100);
		attach.set(300, proc(300, 1, 'claude attach 11111111'));
		const execAttach = await ownershipWith(attach).classify({ token: 't', hookPid: 421, transcriptPath: CLAUDE_TRANSCRIPT, sessionId: ATTACHED_SESSION_ID, at: 1, paneShellPid: 300 });
		assert.deepStrictEqual([exec, execAttach], [{ origin: 'owner', agentKind: 'claude' }, { origin: 'owner', agentKind: 'claude' }]);
	});

	test('agents under a tmux server still succeed the pane owner when the pane shell is known', async () => {
		// tmux のサーバーは launchd の子で、中のエージェントはペインのシェルの子孫ではない（NOTES.md の既知の制限）。
		const tree = new Map([
			[1, proc(1, 0, '/sbin/launchd')],
			[100, proc(100, 1, '/bin/zsh -il')],
			[150, proc(150, 100, 'tmux new-session -s x claude')],
			[500, proc(500, 1, 'tmux new-session -s x claude')],
			[520, proc(520, 500, 'claude')],
			[526, proc(526, 520, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
			[700, proc(700, 1, 'tmux: server (/tmp/tmux-1000/default)')],
			[710, proc(710, 700, '-bash')],
			[720, proc(720, 710, 'claude')],
			[726, proc(726, 720, '/bin/sh /home/user/.para-code/hooks/notify-v5.sh')],
		].map(([pid, info]) => [pid, info] as [number, IParadisHookProcessInfo]));
		const ownership = ownershipWith(tree);
		const first = await ownership.classify({ token: 't', hookPid: 526, transcriptPath: CLAUDE_TRANSCRIPT, at: 1, paneShellPid: 100 });
		// 最初の claude が終わり、Linux 形の tmux サーバーの中で起動し直した
		tree.delete(520);
		tree.delete(526);
		const second = await ownership.classify({ token: 't', hookPid: 726, transcriptPath: CLAUDE_TRANSCRIPT_2, at: 2, paneShellPid: 100 });
		assert.deepStrictEqual([first, second], [{ origin: 'owner', agentKind: 'claude' }, { origin: 'owner', agentKind: 'claude' }]);
	});
});
