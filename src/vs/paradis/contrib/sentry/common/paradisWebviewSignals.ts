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
 * webview から届いたシグナルを Sentry へ記録しつつ購読側へ配る。
 * 正常系(`content-applied`)は量が多いので送信しない。
 */
export function notifyParadisWebviewSignal(signal: IParadisWebviewSignal): void {
	if (signal.code === ParadisWebviewSignalCode.ServiceWorkerControlRecovered || signal.code === ParadisWebviewSignalCode.ServiceWorkerControlTimeout) {
		// `duration_ms` はサニタイザの allowlist に載っているキー。`attempt` も同様。
		reportParadisDiagnosticError('patched', 'webview', signal.code, new Error(`Webview service worker did not take control (${signal.code})`), {
			duration_ms: signal.detail?.['duration_ms'],
			attempt: signal.detail?.['attempt'],
		});
	}
	emitter.fire(signal);
}
