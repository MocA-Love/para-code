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
	/**
	 * 新しいアプリの使用量の画面が、接続先（SSH など）を選んだときだけ付ける `true`。任意項目なので、
	 * 古いアプリは付けない。
	 */
	readonly claudeHost?: unknown;
}

/**
 * `limits` の問い合わせで、Claude を手元の shared process から取るか。
 *
 * 接続先のウィンドウは Claude に接続先のログインを出す。その値を返すのは、アプリが明示的に頼んだ
 * （`claudeHost: true` を付け、ウィンドウを名指しした＝`ws` を持たず `rendererGeneration` を持つ）問い合わせ
 * だけにする。それ以外は、どのウィンドウに届いても従来どおり手元のアカウントを返す:
 *  - ホームやウィジェット（ウィンドウを選ばずに送り、リレーが最初に見つけたウィンドウへ配る）
 *  - 古いアプリ（使用量の画面はウィンドウを名指しするが、接続先のログインの表示を知らない。接続先の名前も
 *    直し方の文言も出せないので、手元のアカウントのまま見せる）
 */
export function paradisMobileLimitsClaudeFromLocal(target: IParadisMobileLimitsRequestTarget): boolean {
	const hasWorkspace = typeof target.ws === 'string' && target.ws.length > 0;
	const namesWindow = !hasWorkspace && typeof target.rendererGeneration === 'number' && Number.isInteger(target.rendererGeneration);
	return !(namesWindow && target.claudeHost === true);
}
