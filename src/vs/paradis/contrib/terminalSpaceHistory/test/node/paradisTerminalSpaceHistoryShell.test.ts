/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import { promisify } from 'util';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const execFileAsync = promisify(execFile);

/**
 * スペースごとのシェル履歴は、シェル統合スクリプトの PARA-PATCH が「ユーザーの rc を読んだ後に」
 * HISTFILE を差し替えることで成り立つ。upstream の取り込みでこの位置や変数名がずれると、
 * 何も言わずに全スペース共通の履歴へ戻るので、実物の zsh / bash で固定しておく。
 *
 * HOME は一時フォルダにする（本物の履歴ファイルには触れない）。
 * 実際の読み込み（↑ キーで出るか）は対話シェルでないと確かめられないため、ここでは HISTFILE の
 * 行き先と、変数が子へ渡らないことだけを見る。
 */
suite('Paradis per-space shell history (shell integration scripts)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const scriptsDirectory = 'vs/workbench/contrib/terminal/common/scripts';
	const zshScript = FileAccess.asFileUri(`${scriptsDirectory}/shellIntegration-rc.zsh`).fsPath;
	const bashScript = FileAccess.asFileUri(`${scriptsDirectory}/shellIntegration-bash.sh`).fsPath;

	/** 外側のターミナルの統合状態と、Para Code の変数を落とした環境。 */
	function cleanEnv(home: string): NodeJS.ProcessEnv {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VSCODE_') && !key.startsWith('PARA_CODE_')));
		return { ...env, HOME: home };
	}

	async function withHome<T>(body: (home: string) => Promise<T>): Promise<T> {
		const home = await fs.mkdtemp(join(tmpdir(), 'paradis-space-history-'));
		try {
			return await body(home);
		} finally {
			await fs.rm(home, { recursive: true, force: true });
		}
	}

	async function available(shell: string): Promise<boolean> {
		return execFileAsync(shell, ['-c', 'exit 0']).then(() => true, () => false);
	}

	async function runZsh(home: string, spaceDirectory: string | undefined): Promise<string> {
		await fs.writeFile(join(home, '.zshrc'), 'HISTFILE=$HOME/.user_history\n');
		const spaceEnv = spaceDirectory === undefined ? {} : { PARA_CODE_SPACE_HISTORY_DIR: spaceDirectory, PARA_CODE_SPACE_HISTORY_ID: 'abc123' };
		const { stdout } = await execFileAsync('zsh', ['-c',
			`USER_ZDOTDIR=${JSON.stringify(home)} VSCODE_INJECTION=1 builtin source ${JSON.stringify(zshScript)} >/dev/null 2>&1; ` +
			'print -r -- "$HISTFILE|${PARA_CODE_SPACE_HISTORY_DIR-unset}|${PARA_CODE_SPACE_HISTORY_ID-unset}"',
		], { env: { ...cleanEnv(home), ZDOTDIR: home, ...spaceEnv } });
		return stdout.trim().replace(home, '~');
	}

	async function runBash(home: string, spaceDirectory: string | undefined): Promise<string> {
		const spaceEnv = spaceDirectory === undefined ? {} : { PARA_CODE_SPACE_HISTORY_DIR: spaceDirectory, PARA_CODE_SPACE_HISTORY_ID: 'abc123' };
		const { stdout } = await execFileAsync('bash', ['-c',
			// `bash -c` は対話シェルではないので ~/.bashrc を読まない。rc が設定した値の代わりに先に置いておく。
			`HISTFILE=$HOME/.user_bash_history; VSCODE_INJECTION=1 builtin source ${JSON.stringify(bashScript)} >/dev/null 2>&1; ` +
			'echo "$HISTFILE|${PARA_CODE_SPACE_HISTORY_DIR-unset}|${PARA_CODE_SPACE_HISTORY_ID-unset}"',
		], { env: { ...cleanEnv(home), ...spaceEnv } });
		return stdout.trim().replace(home, '~');
	}

	test('zsh uses the space history even when ~/.zshrc sets HISTFILE, and does not pass the variables on', async function () {
		if (!await available('zsh')) {
			this.skip();
		}
		await withHome(async home => {
			const spaceDirectory = join(home, 'userData', 'terminal-history', 'abc123');
			assert.deepStrictEqual({
				space: await runZsh(home, spaceDirectory),
				// 他のユーザーから読めないよう 0700 で作る。
				created: await fs.stat(spaceDirectory).then(stat => stat.isDirectory() ? (stat.mode & 0o777).toString(8) : 'not a folder', () => 'missing'),
				none: await runZsh(home, undefined),
			}, {
				space: '~/userData/terminal-history/abc123/zsh_history|unset|unset',
				created: '700',
				none: '~/.user_history|unset|unset',
			});
		});
	});

	test('bash replaces an existing HISTFILE with the space history, and does not pass the variables on', async function () {
		if (!await available('bash')) {
			this.skip();
		}
		await withHome(async home => {
			const spaceDirectory = join(home, 'userData', 'terminal-history', 'abc123');
			assert.deepStrictEqual({
				space: await runBash(home, spaceDirectory),
				none: await runBash(home, undefined),
			}, {
				space: '~/userData/terminal-history/abc123/bash_history|unset|unset',
				none: '~/.user_bash_history|unset|unset',
			});
		});
	});

	test('fish switches the history session name, not the file', async () => {
		// fish は CI に居ないことが多いので、スクリプトの中身で固定する。
		const fishScript = await fs.readFile(FileAccess.asFileUri(`${scriptsDirectory}/shellIntegration.fish`).fsPath, 'utf8');
		assert.deepStrictEqual({
			setsSession: fishScript.includes('set -g fish_history "paracode_$PARA_CODE_SPACE_HISTORY_ID"'),
			clearsVariables: fishScript.includes('set -e PARA_CODE_SPACE_HISTORY_ID'),
		}, { setsSession: true, clearsVariables: true });
	});
});
