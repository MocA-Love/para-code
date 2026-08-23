/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude/OpenAI/GitHub のパブリックステータスAPI(statuspage.io系、CORS制限のないJSON)を叩く
// クライアント。gh CLI(githubMetrics)やps(resourceMonitor)と違いローカルプロセス起動が要らない
// ネットワークGETのみなので、shared process 経由のIPCチャネルは持たず、renderer(electron-browser)
// から IRequestService で直接取得する(userDataProfileInit.ts 等、既存のrenderer直叩きと同じ流儀)。

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { raceTimeout } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { asJson, IRequestService } from '../../../../platform/request/common/request.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import {
	IParadisServiceStatusEntry,
	IParadisServiceStatusSnapshot,
	paradisParseServiceStatusIndicator,
	paradisServiceStatusSeverity,
	PARADIS_SERVICE_STATUS_SOURCES,
	ParadisServiceStatusProvider,
} from '../common/paradisServiceStatus.js';

/** 1件あたりの取得タイムアウト。パブリックAPIとはいえタイトルバーの描画をブロックしないよう短めにする。 */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * エラーメッセージのポップオーバー表示上限。`asJson()` はJSONパース失敗時に応答本文全体を
 * `err.message` へ連結する(キャプティブポータル等がHTMLを200で返すケース)ため、そのまま
 * `IParadisServiceStatusEntry.error` に入れてUIへ出すと長大な本文が漏れ出す。
 */
const ERROR_MESSAGE_MAX_LENGTH = 160;

function truncateErrorMessage(message: string): string {
	if (message.length <= ERROR_MESSAGE_MAX_LENGTH) {
		return message;
	}
	let end = ERROR_MESSAGE_MAX_LENGTH;
	const code = message.charCodeAt(end - 1);
	if (code >= 0xD800 && code <= 0xDBFF) {
		// サロゲートペアの上位ワードで切れる場合は1文字戻し、孤立サロゲートを残さない
		end--;
	}
	return message.slice(0, end) + '…';
}

export class ParadisServiceStatusClient {

	constructor(
		@IRequestService private readonly requestService: IRequestService,
	) { }

	/** 3サービス分を並行取得する。個別の失敗は `unknown` エントリに丸め、全体は常に成功する。 */
	async getSnapshot(): Promise<IParadisServiceStatusSnapshot> {
		const [claude, codex, github] = await Promise.all([
			this.fetchEntry('claude'),
			this.fetchEntry('codex'),
			this.fetchEntry('github'),
		]);
		return { generatedAt: Date.now(), entries: { claude, codex, github } };
	}

	private async fetchEntry(provider: ParadisServiceStatusProvider): Promise<IParadisServiceStatusEntry> {
		const source = PARADIS_SERVICE_STATUS_SOURCES[provider];
		const cts = new CancellationTokenSource();
		try {
			const context = await raceTimeout(
				this.requestService.request({ type: 'GET', url: source.apiUrl, callSite: 'paradisServiceStatus.getSnapshot' }, cts.token),
				REQUEST_TIMEOUT_MS,
				() => cts.cancel(),
			);
			if (!context) {
				throw new Error(localize('paradis.serviceStatus.timeout', "タイムアウトしました"));
			}
			const json = await asJson(context);
			const parsed = paradisParseServiceStatusIndicator(json);
			if (!parsed) {
				throw new Error(localize('paradis.serviceStatus.unexpectedResponse', "予期しない応答形式です"));
			}
			return {
				provider,
				severity: paradisServiceStatusSeverity(parsed.indicator),
				description: parsed.description,
				fetchedAt: Date.now(),
				error: undefined,
			};
		} catch (error) {
			reportParadisDiagnosticError('owned', 'service-status', 'fetch-failed', error, { safe_provider: provider }, 'warning');
			return {
				provider,
				severity: 'unknown',
				description: undefined,
				fetchedAt: Date.now(),
				error: truncateErrorMessage(error instanceof Error ? error.message : String(error)),
			};
		} finally {
			cts.dispose();
		}
	}
}
