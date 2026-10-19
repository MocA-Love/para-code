/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// タスクボード（app/taskboard）を Para Code に同梱する形にビルドする。
//
//   node build/paradis/taskboard/buildTaskBoard.ts [--out <dir>]
//
// 出力（既定は .build/paradis/taskboard。gulpfile.vscode.ts が resources/paradis/taskboard として同梱する）:
//   server/main.mjs  サーバー（esbuild で 1 本にまとめた ESM。npm の依存も中に入れる）
//   dist/**          画面（vite build）
// サーバーは自分の 1 つ上の dist/ を配るので（app/taskboard/server/main.ts の ROOT）、この並びを変えない。
// 配布版の子プロセスは npm を解決できないので（paracode-166 の Office の worker と同じ罠）、依存は全部まとめる。

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
export const PARADIS_TASK_BOARD_APP = join(repositoryRoot, 'app', 'taskboard');
export const PARADIS_TASK_BOARD_DEFAULT_OUT = join(repositoryRoot, '.build', 'paradis', 'taskboard');

function pnpm(args: readonly string[]): void {
	// Windows の pnpm は pnpm.cmd なので、シェルを通さないと起動できない（引数は固定の語だけなので通してよい）
	execFileSync('pnpm', args, { cwd: PARADIS_TASK_BOARD_APP, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CI: process.env.CI ?? 'true' } });
}

/** 画面とサーバーをビルドして `out` に置く。 */
export async function paradisBuildTaskBoard(out: string): Promise<void> {
	if (!existsSync(join(PARADIS_TASK_BOARD_APP, 'node_modules'))) {
		pnpm(['install', '--frozen-lockfile']);
	}
	pnpm(['run', 'build']);
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	cpSync(join(PARADIS_TASK_BOARD_APP, 'dist'), join(out, 'dist'), { recursive: true });
	await esbuild.build({
		entryPoints: [join(PARADIS_TASK_BOARD_APP, 'server', 'main.ts')],
		outfile: join(out, 'server', 'main.mjs'),
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node22',
		// エンジンは Para Code 本体と同じソースを使う（tsconfig と vite の別名と同じ）
		alias: { '@engine': join(repositoryRoot, 'src', 'vs', 'paradis', 'contrib', 'taskBoard', 'common') },
		// vite は開発のときだけ動的に読む。ws の任意の高速化モジュールは無くても動く
		external: ['vite', 'bufferutil', 'utf-8-validate'],
		// ws などの CommonJS の依存が require を使う
		banner: { js: `import { createRequire as __paradisCreateRequire } from 'node:module'; const require = __paradisCreateRequire(import.meta.url);` },
		legalComments: 'none',
		logLevel: 'warning',
	});
}

if (import.meta.main) {
	const { values } = parseArgs({ options: { out: { type: 'string' } } });
	const out = resolve(values.out ?? PARADIS_TASK_BOARD_DEFAULT_OUT);
	await paradisBuildTaskBoard(out);
	console.log(`task board built into ${out}`);
}
