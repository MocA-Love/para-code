/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 常駐ターミナルの保存画面（TM14）を upstream の復元へ渡す口。
//
// upstream の `LocalTerminalBackend.getTerminalLayoutInfo` は、ストレージに保存物が無いときに
// ここを1回呼ぶ（PARA-PATCH は1行）。中身（ファイルを読む、常駐の状態を聞く）は
// `paradisTerminalScreens.contribution.ts` が起動時に {@link paradisSetTerminalScreenSource} で
// 差し込む。差し込まれていなければ何もしない＝upstream のまま。

import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

export interface IParadisTerminalScreenSource {
	/**
	 * そのワークスペースの保存画面を取り出す（取り出したら消す）。使えないときは undefined。
	 * 投げないこと。
	 */
	take(workspaceId: string): Promise<string | undefined>;
}

let source: IParadisTerminalScreenSource | undefined;

export function paradisSetTerminalScreenSource(value: IParadisTerminalScreenSource): IDisposable {
	source = value;
	return toDisposable(() => {
		if (source === value) {
			source = undefined;
		}
	});
}

/**
 * upstream の復元に渡す保存物（`serializeTerminalState` の結果と同じ形の文字列）。
 * 使えるものが無ければ undefined（upstream は何もしない）。
 */
export async function paradisTakeSavedTerminalScreens(workspaceId: string): Promise<string | undefined> {
	const current = source;
	if (!current) {
		return undefined;
	}
	try {
		return await current.take(workspaceId);
	} catch (error) {
		onUnexpectedError(error);
		return undefined;
	}
}
