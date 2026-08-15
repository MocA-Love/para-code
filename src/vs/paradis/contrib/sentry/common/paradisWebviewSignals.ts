/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// webview 内(`pre/index.html` の PARA-PATCH ブロック)から届く健全性シグナルの中継点。
//
// 「Rendered だけ間欠的に白紙になる」不具合の実態は、service worker がその webview を claim できず
// `content` が一度も書き込まれないまま止まることだった。例外にならないので通知にも Sentry にも残らない。
// webview 側でシグナルを出せるようにしたうえで、ここで (1) 診断を Sentry に送り、(2) ビューア側の
// ウォッチドッグへ転送する。upstream 側の触る箇所を webviewElement.ts の1ブロックに閉じるため、
// `IWebview` インターフェースを拡張せずモジュールスコープのイベントで受け渡す。

import { Emitter, Event } from '../../../../base/common/event.js';
import { ParadisDiagnosticSeverity, reportParadisDiagnosticError } from './paradisSentryDiagnostics.js';

/** webview から届くシグナルの種類。 */
export const enum ParadisWebviewSignalCode {
	/** service worker が制御を取れず、登録し直しで復帰した(白紙は回避できた)。 */
	ServiceWorkerControlRecovered = 'sw-control-recovered',
	/** service worker が制限時間内に制御を取れなかった(復帰処理に入る)。 */
	ServiceWorkerControlTimeout = 'sw-control-timeout',
	/**
	 * `navigator.serviceWorker.register()` が期限内に決着しなかった(登録し直しへ進む)。
	 * 実機では resolve も reject もしないまま止まることがあり、その場合は例外が出ないので
	 * このシグナルだけが手がかりになる。
	 */
	ServiceWorkerRegisterTimeout = 'sw-register-timeout',
	/** 登録し直しで決着し、service worker を使える状態に戻った。 */
	ServiceWorkerRegisterRecovered = 'sw-register-recovered',
	/**
	 * 版を1つも持たない registration を見つけた（捨てはしない）。
	 *
	 * `installing`/`waiting`/`active` がすべて空の registration は、Chromium 側では
	 * `status=new / runningStatus=starting` のまま起動を終えられない worker に対応する。
	 * 実機では10秒以上その状態が続き、`navigator.serviceWorker.ready` も永久に解決しない。
	 * `unregister()` も同じく返ってこないため、消そうとするとジョブキューを塞いで悪化する。
	 * ここでは記録だけに留め、起動できない理由は main 側の監視で集める。
	 */
	ServiceWorkerVersionlessRegistrationSeen = 'sw-versionless-registration-seen',
	/**
	 * 登録が期限切れになった後にも、版を持たない registration が残っていた。
	 * 上と同じ状態だが観測点が違うので、Sentry で混ざらないようコードを分けている。
	 */
	ServiceWorkerVersionlessRegistrationAfterTimeout = 'sw-versionless-registration-after-timeout',
	/**
	 * service worker を諦め、無しで描画を続けた。本文は表示できるが `vscode-resource` 経由の
	 * リソース(ローカル画像など)は読めない。白紙で固まるよりましという判断。
	 */
	ServiceWorkerUnavailable = 'sw-unavailable',
	/** 内容の受け取りが始まった(webview は生きている)。この後に service worker の制御待ちが入り得る。 */
	ContentStarted = 'content-started',
	/** service worker の制御待ちを抜けた(ここから先は描画だけ)。 */
	ContentWorkerReady = 'content-worker-ready',
	/** 内側フレームへの内容の書き込みが完了した(＝白紙ではない)。 */
	ContentApplied = 'content-applied',
}

export interface IParadisWebviewSignal {
	/**
	 * シグナルを出した webview の origin。`IWebview.origin` と同じ値なので、購読側は自分が持つ
	 * webview のものかを照合できる。
	 */
	readonly origin: string;
	readonly code: string;
	readonly detail?: { readonly [key: string]: string | number | boolean };
}

const emitter = new Emitter<IParadisWebviewSignal>();

/** webview の健全性シグナル。プロセス寿命と同じなので購読側だけが dispose を持つ。 */
export const onParadisWebviewSignal: Event<IParadisWebviewSignal> = emitter.event;

/**
 * 診断として送る価値がある異常系。正常系(`content-*`)は量が多いので送らない。
 *
 * 値は severity。「復帰した(＝白紙は回避できた)」まで残り全部と同じ error で送ると、実害のある
 * 失敗(`sw-unavailable` — service worker 無しで劣化描画に入った、`...-after-timeout` — 期限切れ後も
 * 版無し registration が残った)が、様子見中や成功で終わった経過の中に埋もれる。
 */
const REPORTED_CODES: ReadonlyMap<string, ParadisDiagnosticSeverity> = new Map([
	// 制御/登録を一度失ったが、登録し直しで白紙を回避できた。実害は無かった。
	[ParadisWebviewSignalCode.ServiceWorkerControlRecovered, 'warning'],
	[ParadisWebviewSignalCode.ServiceWorkerRegisterRecovered, 'warning'],
	// まだ結果が出ていない。この後に登録し直し/復帰処理へ進む途中経過。
	[ParadisWebviewSignalCode.ServiceWorkerControlTimeout, 'warning'],
	[ParadisWebviewSignalCode.ServiceWorkerRegisterTimeout, 'warning'],
	[ParadisWebviewSignalCode.ServiceWorkerVersionlessRegistrationSeen, 'warning'],
	// 最終的に劣化描画または未解決のまま残った。ユーザー体験に実害がある。
	[ParadisWebviewSignalCode.ServiceWorkerUnavailable, 'error'],
	[ParadisWebviewSignalCode.ServiceWorkerVersionlessRegistrationAfterTimeout, 'error'],
]);

/**
 * webview から届いたシグナルを Sentry へ記録しつつ購読側へ配る。
 * 正常系(`content-applied`)は量が多いので送信しない。
 */
export function notifyParadisWebviewSignal(signal: IParadisWebviewSignal): void {
	const severity = REPORTED_CODES.get(signal.code);
	if (severity !== undefined) {
		// `duration_ms` と `attempt` はサニタイザの allowlist に載っているキー。
		// これ以外を足すときは `safe_` 接頭辞を付けること（isParadisSafeExtraKey の
		// 許可リストに無いキーは、送信直前に黙って捨てられる）。
		reportParadisDiagnosticError('patched', 'webview', signal.code, new Error(`Webview service worker problem (${signal.code})`), {
			duration_ms: signal.detail?.['duration_ms'],
			attempt: signal.detail?.['attempt'],
		}, severity);
	}
	emitter.fire(signal);
}
