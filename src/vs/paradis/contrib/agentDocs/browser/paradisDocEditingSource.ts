/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料の「編集中」の印を読む口。コメントの保存先（paradisDocCommentsBackend.ts）と同じく、Markdown のビューアは
// browser 層にあって shared process のチャネルを直接使えないので、デスクトップの起動時に electron-browser の
// contribution（paradisDocEditing.contribution.ts）がここへ口を入れる。口が無い（Web）ときは印を出さない。

import { Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisDocEditingChange, IParadisDocEditingMark } from '../common/paradisDocEditing.js';

/** 印の出どころ（shared process の控え）。 */
export interface IParadisDocEditingSource {
	readonly onDidChange: Event<IParadisDocEditingChange>;
	get(hostId: string, path: string): Promise<IParadisDocEditingMark | undefined>;
}

let source: IParadisDocEditingSource | undefined;

/** 出どころを入れる（デスクトップの起動時に 1 回）。 */
export function paradisSetDocEditingSource(value: IParadisDocEditingSource): IDisposable {
	source = value;
	return toDisposable(() => {
		if (source === value) {
			source = undefined;
		}
	});
}

/** いまの出どころ。無ければ undefined（印を出さない）。 */
export function paradisDocEditingSource(): IParadisDocEditingSource | undefined {
	return source;
}
