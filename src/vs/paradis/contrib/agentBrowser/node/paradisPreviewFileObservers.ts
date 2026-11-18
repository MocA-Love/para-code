/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// `preview_file` がファイルを開いた（または別のスペースへ予約した）後に、別の contrib が動きを足すための口（shared process 内限定）。
// 資料の台帳（agentDocs）が「持ち主のいない html・md を開いたペインの会話の資料にする」に使う。
// ParadisAgentBrowserService から agentDocs を import しないよう、ツールのプロバイダと同じ形の登録口にしている。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

/** `preview_file` が成功した 1 回。 */
export interface IParadisPreviewFileOpened {
	/** 呼び出し元ペインのトークン。 */
	readonly token: string;
	/** エージェントが渡した絶対パス（接続先のペインなら接続先のパス）。 */
	readonly path: string;
	/** 接続先のペインならその接続先（`ssh-remote+<host>` など）。手元なら無い。 */
	readonly remoteAuthority?: string;
	/** 別のスペースを見ている間で、開かずに予約した。 */
	readonly deferred: boolean;
}

/**
 * `preview_file` の成功を受け取る側。ツールの結果の文の後ろへ足す英文 1 つを返せる（無ければ undefined）。
 * 例外を投げても `preview_file` の結果は変わらない。
 */
export type ParadisPreviewFileObserver = (opened: IParadisPreviewFileOpened) => Promise<string | undefined> | string | undefined;

const observers = new Set<ParadisPreviewFileObserver>();

/** `preview_file` の成功を受け取る側を足す。 */
export function paradisRegisterPreviewFileObserver(observer: ParadisPreviewFileObserver): IDisposable {
	observers.add(observer);
	return toDisposable(() => observers.delete(observer));
}

/**
 * 登録された側へ `preview_file` の成功を知らせ、返ってきた英文を空白でつないで返す（無ければ空文字）。
 * 1 つが失敗しても残りは続ける。
 */
export async function paradisNotifyPreviewFileOpened(opened: IParadisPreviewFileOpened): Promise<string> {
	const notes: string[] = [];
	for (const observer of [...observers]) {
		try {
			const note = await observer(opened);
			if (typeof note === 'string' && note.length > 0) {
				notes.push(note);
			}
		} catch {
			// 足す動きの失敗で、開けたファイルを失敗にしない
		}
	}
	return notes.join(' ');
}
