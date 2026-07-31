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
import { reportParadisDiagnosticError } from './paradisSentryDiagnostics.js';

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
	 * 版を1つも持たない registration が残っていたので捨てた。
	 *
	 * `installing`/`waiting`/`active` がすべて空の registration は、そのままでは二度と
	 * worker を持たない。実機の計測ではこの状態が10秒以上続き、SW プロセスが一度も起動せず、
	 * `navigator.serviceWorker.ready` も永久に解決しなかった。放置すると `register()` の
	 * 期限切れを待つ分だけ白紙の時間が延びるので、登録の前に捨てる。
	 */
	ServiceWorkerVersionlessRegistrationDiscarded = 'sw-versionless-registration-discarded',
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

/** 診断として送る価値がある異常系。正常系(`content-*`)は量が多いので送らない。 */
const REPORTED_CODES: ReadonlySet<string> = new Set<string>([
	ParadisWebviewSignalCode.ServiceWorkerControlRecovered,
	ParadisWebviewSignalCode.ServiceWorkerControlTimeout,
	ParadisWebviewSignalCode.ServiceWorkerRegisterTimeout,
	ParadisWebviewSignalCode.ServiceWorkerRegisterRecovered,
	ParadisWebviewSignalCode.ServiceWorkerUnavailable,
	ParadisWebviewSignalCode.ServiceWorkerVersionlessRegistrationDiscarded,
]);

/**
 * webview から届いたシグナルを Sentry へ記録しつつ購読側へ配る。
 * 正常系(`content-applied`)は量が多いので送信しない。
 */
export function notifyParadisWebviewSignal(signal: IParadisWebviewSignal): void {
	if (REPORTED_CODES.has(signal.code)) {
		// `duration_ms` はサニタイザの allowlist に載っているキー。`attempt` も同様。
		// `safe_removed` は「実際に捨てられたか」。版なし registration の判定が本物だったのか、
		// 別の client が先に片付けた後だったのかを、あとからログだけで見分けるために要る。
		// キーは `safe_` 接頭辞でないと isParadisSafeExtraKey の許可リストに落とされる。
		reportParadisDiagnosticError('patched', 'webview', signal.code, new Error(`Webview service worker problem (${signal.code})`), {
			duration_ms: signal.detail?.['duration_ms'],
			attempt: signal.detail?.['attempt'],
			safe_removed: signal.detail?.['safe_removed'],
		});
	}
	emitter.fire(signal);
}
