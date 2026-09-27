/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ダウンロードしたファイルへ OS の隔離の印を付ける。
//
// Chrome は保存したファイルへ macOS の `com.apple.quarantine` と Windows の Mark-of-the-Web
// （`Zone.Identifier` の代替データストリーム）を付け、開いたときに Gatekeeper / SmartScreen の警告を
// 出させる。Chromium でこれを行うのは埋め込み側（Chrome の DownloadManagerDelegate）で、Electron が
// 同じことをするとは限らない。そこで完了のたびに印の有無を確かめ、無いときだけ付ける（あれば触らない）。
// Linux には相当する仕組みが無いので何もしない。

import { execFile } from 'child_process';
import * as fs from 'fs';
import { generateUuid } from '../../../../base/common/uuid.js';

/** 外部コマンドを実行する口（テストでは偽物を渡す）。終了コードが 0 なら true。 */
export type ParadisRunCommand = (file: string, args: readonly string[]) => Promise<boolean>;

export interface IParadisQuarantineHost {
	readonly platform: NodeJS.Platform;
	readonly run: ParadisRunCommand;
	readonly exists: (path: string) => boolean;
	readonly writeFile: (path: string, content: string) => void;
	readonly now: () => number;
}

function runCommand(file: string, args: readonly string[]): Promise<boolean> {
	return new Promise(resolve => {
		execFile(file, [...args], { timeout: 5_000 }, error => resolve(!error));
	});
}

export const paradisDefaultQuarantineHost: IParadisQuarantineHost = {
	platform: process.platform,
	run: runCommand,
	exists: path => fs.existsSync(path),
	writeFile: (path, content) => fs.writeFileSync(path, content),
	now: Date.now,
};

/** 印に書く取得元。資格情報（user:pass@）は落とす。読めない URL は書かない。 */
function sanitizeSourceUrl(sourceUrl: string): string | undefined {
	try {
		const url = new URL(sourceUrl);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return undefined;
		}
		url.username = '';
		url.password = '';
		return url.toString();
	} catch {
		return undefined;
	}
}

/**
 * 印が無ければ付ける。失敗しても例外は投げない（一覧への表示は妨げない）。
 * @returns 新たに印を付けたか
 */
export async function paradisEnsureDownloadQuarantine(path: string, sourceUrl: string, host: IParadisQuarantineHost = paradisDefaultQuarantineHost): Promise<boolean> {
	try {
		if (host.platform === 'darwin') {
			if (await host.run('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path])) {
				return false;
			}
			// 形式は「フラグ;16進の時刻;付けたアプリ;UUID」。0081 は Safari などが付ける値と同じ
			// （隔離あり・ダウンロード由来）。
			const value = `0081;${Math.floor(host.now() / 1000).toString(16)};Para Code;${generateUuid().toUpperCase()}`;
			return await host.run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, path]);
		}
		if (host.platform === 'win32') {
			const stream = `${path}:Zone.Identifier`;
			if (host.exists(stream)) {
				return false;
			}
			const source = sanitizeSourceUrl(sourceUrl);
			// ZoneId=3 はインターネット。Chrome が書くのと同じ形。
			host.writeFile(stream, `[ZoneTransfer]\r\nZoneId=3\r\n${source ? `HostUrl=${source}\r\n` : ''}`);
			return true;
		}
		return false;
	} catch {
		return false;
	}
}
