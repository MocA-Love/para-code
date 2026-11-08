/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Xcode の Device Hub が起動しているかを確かめ、裏で起動する（q.html Q585 の ⑤）。
//
// serve-sim の開閉（iPhone Duo の fold）は Device Hub が起動していないと断られる（Xcode 27.2 の Mac で実測。
// `open -g` で裏で起動すると通る）。起動するのは利用者がペインのボタンを押したときだけで、エージェントの
// mobile_fold からは起動せず、起動の案内を返す。
//
// ここで見るのは「Device Hub のアプリが動いているか」。① の Device Hub の検知（notifyutil の dtuhidd.active）は
// 「Device Hub が入力を奪っているか」で、別のもの。

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { dirname, join } from '../../../../base/common/path.js';

/** コマンドを呼ぶ口（テストで差し替える）。 */
export type ParadisDeviceHubExec = (file: string, args: readonly string[]) => Promise<string>;

const realExec: ParadisDeviceHubExec = (file, args) => new Promise((resolve, reject) => {
	execFile(file, [...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
});

/** Device Hub の実行ファイルのパスに含まれる印。 */
const DEVICE_HUB_APP_MARK = '/DeviceHub.app/Contents/MacOS/';

/** `ps -axo comm=` の出力に Device Hub があるか。 */
export function paradisDeviceHubInProcessList(stdout: string): boolean {
	return stdout.split('\n').some(line => line.includes(DEVICE_HUB_APP_MARK));
}

/** `xcode-select -p`（例 `/Applications/Xcode.app/Contents/Developer`）から Device Hub のアプリの場所。 */
export function paradisDeviceHubAppPath(developerDir: string): string {
	return join(dirname(developerDir.trim()), 'Applications', 'DeviceHub.app');
}

export class ParadisSimulatorDeviceHub {

	constructor(private readonly _exec: ParadisDeviceHubExec = realExec) { }

	async isRunning(): Promise<boolean> {
		return paradisDeviceHubInProcessList(await this._exec('ps', ['-axo', 'comm=']));
	}

	/** 裏で（前に出さずに）起動する。Device Hub が見つからなければ投げる。 */
	async open(): Promise<void> {
		const app = paradisDeviceHubAppPath(await this._exec('xcode-select', ['-p']));
		try {
			await fs.access(app);
		} catch {
			throw new Error(`Device Hub was not found at ${app}. It ships with Xcode 26 or later.`);
		}
		await this._exec('open', ['-g', app]);
	}
}
