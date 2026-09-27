/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisHookProcessInfo } from '../../../agentBrowser/node/paradisAgentHookOwnership.js';
import { paradisRunningCodexHome } from '../../common/paradisCodexAccounts.js';
import { paradisCodexPaneProcesses, paradisFindCodexUnderShells, paradisParseCodexHomeFromProcEnviron, paradisParseCodexHomeFromPsEnvironment } from '../../node/paradisCodexPaneProcesses.js';

function table(rows: readonly [pid: number, ppid: number, command: string][]): Map<number, IParadisHookProcessInfo> {
	return new Map(rows.map(([pid, ppid, command]) => [pid, { pid, ppid, startKey: undefined, command }]));
}

// 再接続したペイン（実行中のコマンドが残っていない）や npm 版（前面のプロセス名が node）、
// `echo …; codex` の行から起動した Codex も、シェルの子孫のプロセス表で見分ける。
// パスの正規化（resolve）が POSIX の形を前提にしているので Windows では流さない
(isWindows ? suite.skip : suite)('Paradis Codex pane processes', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('finds Codex under a shell, including npm Codex, nested launches and wrappers, and ignores other programs', () => {
		const snapshot = table([
			// npm 版: node が bin/codex.js を動かし、vendor の本体を子に起こす
			[100, 1, '-zsh'],
			[101, 100, 'node /Users/example/.npm-global/bin/codex'],
			[102, 101, '/Users/example/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex'],
			// `echo hi; codex resume` の行（zsh の子として codex が動く）
			[200, 1, '/bin/zsh -l'],
			[201, 200, 'codex resume 019a'],
			// tmux の中の Codex はシェルの子孫ではない（tmux サーバーの子）ので数えない
			[300, 1, '/bin/zsh -l'],
			[301, 300, 'tmux attach'],
			// Claude Code と、引数に codex を含むだけのコマンド
			[400, 1, '/bin/bash'],
			[401, 400, 'claude --resume'],
			[402, 400, 'grep codex notes.md'],
			// 深い入れ子
			[500, 1, '/bin/zsh'],
			[501, 500, 'env FOO=1 bash'],
			[502, 501, 'npx codex'],
			[503, 502, 'node /Users/example/.npm/_npx/abc/node_modules/.bin/codex'],
		]);
		assert.deepStrictEqual({
			running: paradisFindCodexUnderShells([100, 200, 300, 400, 500, 999], snapshot),
			unknownTable: paradisFindCodexUnderShells([100], undefined),
		}, {
			// Codex のプロセスはシェルにいちばん近いもの（npm 版なら node のプロセス）
			running: [{ shellPid: 100, codexPid: 101 }, { shellPid: 200, codexPid: 201 }, { shellPid: 500, codexPid: 503 }],
			unknownTable: [],
		});
	});

	// 再接続したペインは開いたときのホームを覚えていないので、動いている Codex の CODEX_HOME を読む。
	// 環境変数から取り出すのは CODEX_HOME の値だけで、ほかの変数（秘密が入りうる）は結果に残さない。
	test('reads only CODEX_HOME from a Codex process environment, from ps -E on macOS and /proc on Linux', () => {
		const uid = 501;
		assert.deepStrictEqual({
			spaced: paradisParseCodexHomeFromPsEnvironment(`  501 node /Users/example/.npm-global/bin/codex resume TERM=xterm CODEX_HOME=/Users/John Smith/.codex-2 PATH=/usr/bin SECRET_TOKEN=abc\n`, uid),
			unset: paradisParseCodexHomeFromPsEnvironment('  501 codex PATH=/usr/bin HOME=/Users/example\n', uid),
			hidden: paradisParseCodexHomeFromPsEnvironment('  501 codex\n', uid),
			otherUser: paradisParseCodexHomeFromPsEnvironment('  502 codex PATH=/usr/bin CODEX_HOME=/Users/other/.codex-2\n', uid),
			linux: paradisParseCodexHomeFromProcEnviron(Buffer.from('PATH=/usr/bin\0CODEX_HOME=/home/u/.codex-3\0SECRET=x\0')),
			linuxUnset: paradisParseCodexHomeFromProcEnviron(Buffer.from('PATH=/usr/bin\0SECRET=x\0')),
		}, {
			spaced: { known: true, codexHome: '/Users/John Smith/.codex-2' },
			unset: { known: true, codexHome: undefined },
			hidden: { known: false },
			otherUser: { known: false },
			linux: { known: true, codexHome: '/home/u/.codex-3' },
			linuxUnset: { known: true },
		});
	});

	// 再現: 再接続した P1・P2 は ~/.codex-2 で動いている。~/.codex-2 へ切り替えたら「前のアカウントのまま」に数えない。
	test('uses the running Codex home over the switch-time assumption for reattached panes', async () => {
		const snapshot = table([
			[10, 1, '-zsh'], [11, 10, 'node /Users/example/.npm-global/bin/codex'],
			[20, 1, '-zsh'], [21, 20, 'codex'],
			[30, 1, '-zsh'], [31, 30, 'codex'],
			[40, 1, '-zsh'], [41, 40, 'codex'],
		]);
		const homes = new Map([[11, { known: true, codexHome: '/home/u/.codex-2/' }], [21, { known: true, codexHome: '/home/u/.codex-2' }], [31, { known: true, codexHome: '/home/u/.codex' }], [41, { known: false }]]);
		const found = await paradisCodexPaneProcesses([10, 20, 30, 40], snapshot, async pid => homes.get(pid) ?? { known: false }, '/home/u/.codex');
		// 直前の選択は既定のホーム、切り替え先は ~/.codex-2。再接続したペインなので開いたときのホームは分からない
		const next = '/home/u/.codex-2';
		const onPrevious = found.filter(process => paradisRunningCodexHome(process, { known: false }, undefined) !== next).map(process => process.shellPid);
		assert.deepStrictEqual({ found, onPrevious }, {
			found: [
				{ shellPid: 10, homeKnown: true, codexHome: '/home/u/.codex-2' },
				{ shellPid: 20, homeKnown: true, codexHome: '/home/u/.codex-2' },
				// 既定のホームと同じ場所を CODEX_HOME にしていても既定として扱う
				{ shellPid: 30, homeKnown: true },
				{ shellPid: 40, homeKnown: false },
			],
			// P1・P2（~/.codex-2）は数えない。既定のホームの P3 と、読めなかった P4（直前の選択とみなす）は数える
			onPrevious: [30, 40],
		});
	});
});
