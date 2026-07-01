/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Para Code（Electron）本体のremote-debuggingエンドポイント（上流CDP）の発見と参照。
// electron-mainが `--remote-debugging-port=0` で起動すると、Chromiumが
// `<userDataDir>/DevToolsActivePort` に実際のポート番号を書き出す（1行目）。
// shared processはそのファイルを読んで上流ポートを解決する（動的割当なので
// 複数インスタンス起動時のポート衝突が起きない）。
//
// 【重要】この生ポートはフィルタ無しで全webContents（ワークベンチウィンドウ含む）に
// 触れられる。Chromiumは remote-debugging を 127.0.0.1 にのみバインドするが、
// 詳細な扱いは NOTES.md の「CDPゲートウェイとリモートデバッグ」を参照。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';

const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 上流（Electron本体）のCDPエンドポイント解決器。
 * ポートはアプリ起動中は不変なので、一度読めたらキャッシュする。
 */
export class ParadisCdpUpstream {

	private _cachedPort: number | undefined;

	constructor(
		private readonly userDataPath: string,
		private readonly logService: ILogService,
	) { }

	/**
	 * `DevToolsActivePort` ファイルから上流CDPポートを解決する。
	 * ファイルがまだ書かれていない起動直後に備えて短いリトライを行う。
	 */
	async resolvePort(timeoutMs = 5000): Promise<number | undefined> {
		if (this._cachedPort !== undefined) {
			return this._cachedPort;
		}
		const deadline = Date.now() + timeoutMs;
		for (; ;) {
			const port = await this._readPortFile();
			if (port !== undefined) {
				this._cachedPort = port;
				this.logService.info(`[ParadisCdpGateway] Upstream CDP port resolved: ${port}`);
				return port;
			}
			if (Date.now() >= deadline) {
				this.logService.warn('[ParadisCdpGateway] DevToolsActivePort not found (is remote debugging enabled in electron-main?)');
				return undefined;
			}
			await delay(100);
		}
	}

	/** 上流の `/json/*` エンドポイントを取得してJSONで返す。 */
	async fetchJson(path: string): Promise<unknown> {
		const port = await this.resolvePort();
		if (!port) {
			throw new Error('Upstream Chromium CDP port not available');
		}
		const res = await fetch(`http://127.0.0.1:${port}${path}`);
		if (!res.ok) {
			throw new Error(`Upstream CDP returned ${res.status} for ${path}`);
		}
		return res.json();
	}

	private async _readPortFile(): Promise<number | undefined> {
		try {
			const contents = await fs.readFile(join(this.userDataPath, DEVTOOLS_PORT_FILE), 'utf8');
			const firstLine = contents.split(/\r?\n/, 1)[0]?.trim();
			if (!firstLine) {
				return undefined;
			}
			const port = Number.parseInt(firstLine, 10);
			return Number.isFinite(port) && port > 0 ? port : undefined;
		} catch {
			return undefined;
		}
	}
}
