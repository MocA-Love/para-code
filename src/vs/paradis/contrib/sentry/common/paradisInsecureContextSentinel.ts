/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// secure context の regression sentinel。判定と報告先の選択だけをここに置き、実際の globals と
// Sentry は呼び出し側（electron-browser）から渡す。renderer 側のモジュールは読み込むだけで
// Sentry の初期化が走るため、そこに判定を置いたままだとテストから触れない。

/** Sentry と console のどちらに出しても文面を揃えるための本文。 */
export const PARADIS_INSECURE_CONTEXT_MESSAGE =
	'Renderer is not a secure context, so crypto.subtle is unavailable and webviews cannot mount';

export interface IParadisInsecureContextProbe {
	/** `globalThis.isSecureContext`。 */
	readonly isSecureContext: boolean;
	/** `globalThis.crypto?.subtle`。undefined なら webview は mount できない。 */
	readonly subtleCrypto: unknown;
	/** Sentry へ送る。未初期化なら空の id を返す（`captureParadisRendererException` と同じ約束）。 */
	readonly report: (message: string) => string;
	/** Sentry へ送れなかったときの退避先。 */
	readonly log: (message: string) => void;
}

/**
 * `vscode-file` が secure scheme として登録されたままかを確かめ、崩れていれば報告する。
 *
 * 崩れると workbench が secure context でなくなり、`crypto.subtle` が消え、webview
 * （Markdown プレビュー、Para Code のファイルビューア、更新履歴、拡張の webview）が
 * すべて mount しなくなる。upstream はこれを「最初に webview を開いたときの unhandled
 * rejection」としてしか出さず、しかも scope フィルタが upstream 由来のイベントを捨てるため、
 * ここで自前で報告する。ウィンドウごとに起動時1回、ユーザーが webview を開くかどうかに関わらず。
 *
 * **Sentry が立ち上がったかどうかに依存させない。** Sentry が壊れているときこそ、この検知が
 * 最も必要になる。送れなかった場合は黙って消さずに console へ出す。
 *
 * @returns 報告先。`none` は健全、`sentry` は送信済み、`console` は Sentry へ送れず退避したこと。
 */
export function paradisReportInsecureContextSentinel(probe: IParadisInsecureContextProbe): 'none' | 'sentry' | 'console' {
	if (probe.isSecureContext && probe.subtleCrypto !== undefined) {
		return 'none';
	}
	if (probe.report(PARADIS_INSECURE_CONTEXT_MESSAGE) !== '') {
		return 'sentry';
	}
	probe.log(`[Para Code] ${PARADIS_INSECURE_CONTEXT_MESSAGE}`);
	return 'console';
}
