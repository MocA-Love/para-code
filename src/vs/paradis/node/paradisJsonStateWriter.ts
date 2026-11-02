/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisWriteFileAtomic } from './paradisWriteFileAtomic.js';

/**
 * 状態のファイル（userData の小さな JSON）を 1 つずつ順に、一時ファイル＋rename で書く。
 *
 * 書いている間に届いた書き込みは、まだ始まっていないものに中身を差し替えてまとめる（最後の中身だけを書く）。
 * 同じ瞬間に何度も変わっても（拡張機能が `contextMenus.create` を続けて呼ぶなど）、書くのは「今の書き込み」と
 * 「その後の最新」の 2 回までになる。返す Promise は、渡した中身かそれより新しい中身を書き終えたら解決し、
 * その書き込みが失敗したら reject する。
 */
export class ParadisJsonStateWriter {

	private _tail: Promise<void> = Promise.resolve();
	private _next: { content: string; readonly done: Promise<void> } | undefined;

	/**
	 * @param _createParent 親のフォルダが無ければ作る（`fs.mkdir(..., { recursive: true })` と同じ権限）。
	 */
	constructor(private readonly _path: string, private readonly _createParent = false) { }

	write(content: string): Promise<void> {
		if (this._next !== undefined) {
			this._next.content = content;
			return this._next.done;
		}
		const next: { content: string; done: Promise<void> } = { content, done: Promise.resolve() };
		next.done = this._tail.then(() => {
			// ここから先に届いた書き込みは、この次に回す
			this._next = undefined;
			return paradisWriteFileAtomic(this._path, next.content, this._createParent ? { createParentMode: 0o777 } : {});
		});
		this._next = next;
		this._tail = next.done.catch(() => undefined);
		return next.done;
	}
}
