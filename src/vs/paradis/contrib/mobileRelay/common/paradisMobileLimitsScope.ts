/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** モバイルの `limits` の問い合わせのうち、Claude の出どころを決めるのに使う項目。 */
export interface IParadisMobileLimitsRequestTarget {
	readonly ws?: unknown;
	readonly rendererGeneration?: unknown;
}

/**
 * `limits` の問い合わせで、Claude を手元の shared process から取るか。
 *
 * SSH のウィンドウは Claude に接続先のログインを出す。その値を返すのは、アプリが使用量の画面で接続先を
 * 選び、ウィンドウを名指しした（`ws` を持たず `rendererGeneration` を持つ）問い合わせだけにする。ホームや
 * ウィジェットのようにウィンドウを選ばずに届いた問い合わせ（アプリが最初に見つけたウィンドウの `ws` を
 * 付けて送る）は、どのウィンドウが答えるかで Claude のアカウントが入れ替わらないよう、従来どおり手元の
 * アカウントを返す（古いアプリもこちらになる）。
 */
export function paradisMobileLimitsClaudeFromLocal(target: IParadisMobileLimitsRequestTarget): boolean {
	const hasWorkspace = typeof target.ws === 'string' && target.ws.length > 0;
	const namesWindow = !hasWorkspace && typeof target.rendererGeneration === 'number' && Number.isInteger(target.rendererGeneration);
	return !namesWindow;
}
