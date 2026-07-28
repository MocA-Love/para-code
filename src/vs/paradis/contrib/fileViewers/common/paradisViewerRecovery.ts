/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Rendered(webview)が白紙のまま返ってこないときに、作り直しを何回まで試すかを決める方針。
// 判断だけを持つ純粋なクラスにして、webview の生成・破棄を伴う実処理から切り離す。

/** 白紙を検知したときに取る手。 */
export type ParadisViewerRecoveryAction = 'retry' | 'fallback';

/** Rendered が描き終わるのを待つ基本の上限。claim 済みの webview なら通常は 1 秒未満で戻る。 */
export const PARADIS_VIEWER_CONTENT_TIMEOUT_MS = 8_000;

/**
 * webview 側が service worker の制御待ちに使い得る最悪の時間（`pre/index.html` の PARA-PATCH ブロック。
 * 制御待ち 2 回分と登録し直しのオーバーヘッド）。
 *
 * ここを短く見積もると、webview が自力で復帰しかけている最中にホスト側が先に見切って作り直してしまい、
 * 復帰の芽を潰したうえにリトライ回数だけ消費する。制御待ちを抜けた合図（content-worker-ready）が
 * 届いた時点でこの猶予は外す。定数の対応は paradisWebviewServiceWorkerControl のテストで突き合わせる。
 */
export const PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS = 12_000;

/** これを超えるごとに待ち時間を延ばす HTML の長さ（バイト数ではなく文字数）。 */
const PARADIS_VIEWER_LARGE_DOCUMENT_CHARS = 2_000_000;

/** 待ち時間の上限。ここまで待って何も届かなければ、大きさの問題ではないと判断する。 */
const PARADIS_VIEWER_MAX_CONTENT_TIMEOUT_MS = 40_000;

/**
 * 生成した HTML の大きさに応じた待ち時間を返す。
 *
 * 巨大なドキュメントは webview 側の解析だけで数秒かかるため、固定の待ち時間だと「正常に描画中」を
 * 白紙と誤判定して作り直してしまい、かえって表示が遅くなる。
 */
export function paradisViewerContentTimeout(htmlLength: number): number {
	const extraChunks = Math.floor(Math.max(0, htmlLength) / PARADIS_VIEWER_LARGE_DOCUMENT_CHARS);
	return Math.min(PARADIS_VIEWER_CONTENT_TIMEOUT_MS * (1 + extraChunks), PARADIS_VIEWER_MAX_CONTENT_TIMEOUT_MS);
}

/**
 * 直近 {@link windowMs} の失敗回数で作り直し(`retry`)と Raw への切り替え(`fallback`)を決める。
 *
 * 作り直しを無制限に繰り返すと、webview が原因ではない不具合(生成した HTML 自体が壊れている等)で
 * 無限ループになり、CPU を焼いたまま画面は白紙のままになる。回数で頭打ちにして、最後は必ず
 * 中身が読める Raw へ倒す。
 */
export class ParadisViewerRecoveryPolicy {

	private readonly failures: number[] = [];

	constructor(
		private readonly maxRetries: number = 2,
		private readonly windowMs: number = 60_000,
		private readonly now: () => number = Date.now,
	) { }

	/** 白紙を1回記録し、次に取るべき手を返す。 */
	recordFailure(): ParadisViewerRecoveryAction {
		const currentTime = this.now();
		// 期限切れの失敗は捨てる。半日開いていたタブがたまたま2回失敗しただけで Raw に落ちないようにする。
		for (let index = this.failures.length - 1; index >= 0; index--) {
			if (currentTime - this.failures[index] >= this.windowMs) {
				this.failures.splice(index, 1);
			}
		}
		this.failures.push(currentTime);
		return this.failures.length <= this.maxRetries ? 'retry' : 'fallback';
	}

	/** 描画が成功したので失敗の記録を捨てる。 */
	recordSuccess(): void {
		this.failures.length = 0;
	}

	/**
	 * 失敗の記録を捨てて最初からやり直す。
	 *
	 * 記録はペイン（＝エディタのインスタンス）が持つが、ペインは別のファイルを開くときも使い回される。
	 * リセットしないと、前のファイルで失敗した回数のせいで次のファイルが初回の失敗で Raw に落ちる。
	 * ユーザーが自分で Rendered を選び直したときも、やり直しの意思表示として扱う。
	 */
	reset(): void {
		this.failures.length = 0;
	}
}
