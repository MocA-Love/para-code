/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 同梱した serve-sim（`media/serve-sim/`）の場所と、実行ビットの手当て。

import { promises as fs, constants } from 'fs';
import { join } from '../../../../base/common/path.js';
import { PARADIS_SERVE_SIM_VERSION } from '../common/paradisSimulator.js';

/** 同梱した serve-sim の場所（`out/` からの相対）。 */
export const PARADIS_SERVE_SIM_DIR = 'vs/paradis/contrib/simulator/node/media/serve-sim';

/** ホストが読むミドルウェア（serve-sim の公開の export `serve-sim/middleware`）。 */
export const PARADIS_SERVE_SIM_MIDDLEWARE = 'dist/middleware.js';

/** `simctl spawn` などで起こす実行ファイル。拡張子が無いので、配布の途中で実行ビットが落ちうる。 */
export const PARADIS_SERVE_SIM_EXECUTABLES: readonly string[] = [
	'dist/simduo/serve-sim-duo-hid',
	'dist/simax/serve-sim-ax-settings',
];

async function isExecutable(path: string): Promise<boolean> {
	try {
		await fs.access(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 実際に読む serve-sim のフォルダを返す。実行ファイルに実行ビットがあれば同梱のまま。
 * 無ければ（配布の途中で落ちた場合。【要確認】Mac の配布版）、`scratchDir` の下へ写して実行ビットを付け、
 * そちらを返す。serve-sim の `native.ts` は `serve-sim-native.node` の隣の並びから補助を引くので、
 * フォルダごと写す。
 */
export async function paradisPrepareServeSimDir(sourceDir: string, scratchDir: string): Promise<string> {
	const executable = await Promise.all(PARADIS_SERVE_SIM_EXECUTABLES.map(file => isExecutable(join(sourceDir, file))));
	if (executable.every(Boolean)) {
		return sourceDir;
	}
	const copy = join(scratchDir, `serve-sim-${PARADIS_SERVE_SIM_VERSION}`);
	await fs.cp(sourceDir, copy, { recursive: true, force: true });
	for (const file of PARADIS_SERVE_SIM_EXECUTABLES) {
		await fs.chmod(join(copy, file), 0o755);
	}
	return copy;
}
