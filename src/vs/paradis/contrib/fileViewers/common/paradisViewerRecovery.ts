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

/** 描き終わるのを待つ時間が切れたときに取る手。`extend` は作り直さずにもう一度だけ待つ。 */
export type ParadisViewerTimeoutAction = 'extend' | ParadisViewerRecoveryAction;

/** Rendered が描き終わるのを待つ基本の上限。claim 済みの webview なら通常は 1 秒未満で戻る。 */
export const PARADIS_VIEWER_CONTENT_TIMEOUT_MS = 8_000;

/**
 * webview 側が service worker の準備に使い得る最悪の時間（`pre/index.html` の PARA-PATCH ブロック）。
 * 登録・更新・制御待ち・登録し直しをすべて含む予算（`PARA_SW_SETUP_BUDGET_MS`）を上回っている必要がある。
 *
 * ここを短く見積もると、webview が自力で復帰しかけている最中にホスト側が先に見切って作り直してしまい、
 * 復帰の芽を潰したうえにリトライ回数だけ消費する。webview 側は予算を使い切ると service worker 無しで
 * 描画へ進むので、この猶予まで待てば「白紙のまま」で終わることはない。制御待ちを抜けた合図
 * （content-worker-ready）が届いた時点でこの猶予は外す。定数の対応は
 * paradisWebviewServiceWorkerControl のテストで突き合わせる。
 */
export const PARADIS_VIEWER_SERVICE_WORKER_GRACE_MS = 22_000;

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
 *
 * webview から合図が 1 つも来ないまま時間が切れたときは、成功するまでに 1 回だけ、作り直さずに
 * 同じ長さをもう一度待つ（`extend`）。機械が混んでいると webview のプロセスの起動だけで時間を
 * 使い切る（paracode-165〜167 の白紙の報告は、1 件を除いて合図なし・8 秒ちょうどだった）。
 * そこで作り直すと起動からやり直しになり、同じ理由でまた間に合わない。
 */
export class ParadisViewerRecoveryPolicy {

	private readonly failures: number[] = [];
	/** 成功するまでの間に、もう延長を使ったか。 */
	private extensionUsed = false;
	/** いま待っているのが延長か。 */
	private extendingWait = false;

	constructor(
		private readonly maxRetries: number = 2,
		private readonly windowMs: number = 60_000,
		private readonly now: () => number = Date.now,
	) { }

	/** 白紙を1回記録し、次に取るべき手を返す。 */
	recordFailure(): ParadisViewerRecoveryAction {
		this.extendingWait = false;
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

	/**
	 * 待つ時間が切れた。`signalSeen` は webview から何かしらの合図が届いていたか。
	 *
	 * 合図が無く、まだ延長を使っていなければ `extend` を返して失敗に数えない。それ以外は
	 * {@link recordFailure} と同じ。
	 */
	recordTimeout(signalSeen: boolean): ParadisViewerTimeoutAction {
		if (!signalSeen && !this.extensionUsed) {
			this.extensionUsed = true;
			this.extendingWait = true;
			return 'extend';
		}
		return this.recordFailure();
	}

	/** いま待っているのが延長か（延長が切れて失敗を記録したら false に戻る）。 */
	get extending(): boolean {
		return this.extendingWait;
	}

	/** 新しい描画を送った。前の描画で始めた延長は、この描画の待ちには引き継がない。 */
	renderStarted(): void {
		this.extendingWait = false;
	}

	/** 描画が成功したので失敗の記録を捨てる。延長の最中に描けたなら true を返す。 */
	recordSuccess(): boolean {
		const rescued = this.extendingWait;
		this.failures.length = 0;
		this.extensionUsed = false;
		this.extendingWait = false;
		return rescued;
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
		this.extensionUsed = false;
		this.extendingWait = false;
	}
}
