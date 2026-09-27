/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisHookProcessInfo } from '../../../agentBrowser/node/paradisAgentHookOwnership.js';
import { paradisShellsRunningCodex } from '../../node/paradisCodexPaneProcesses.js';

function table(rows: readonly [pid: number, ppid: number, command: string][]): Map<number, IParadisHookProcessInfo> {
	return new Map(rows.map(([pid, ppid, command]) => [pid, { pid, ppid, startKey: undefined, command }]));
}

// 再接続したペイン（実行中のコマンドが残っていない）や npm 版（前面のプロセス名が node）、
// `echo …; codex` の行から起動した Codex も、シェルの子孫のプロセス表で見分ける。
suite('Paradis Codex pane processes', () => {
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
			running: paradisShellsRunningCodex([100, 200, 300, 400, 500, 999], snapshot),
			unknownTable: paradisShellsRunningCodex([100], undefined),
		}, {
			running: [100, 200, 500],
			unknownTable: [],
		});
	});
});
