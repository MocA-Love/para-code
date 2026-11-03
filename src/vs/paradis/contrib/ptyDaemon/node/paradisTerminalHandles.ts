/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの番号と handle の台帳だけを置く。paradisDaemonTerminalProcess.ts が台帳に書き、
// paradisTerminalProcessFactory.ts がその器を作るので、台帳を工場のファイルに置くと 2 つが循環する。
// 今までの読み手のために、工場のファイルからも同じものを出している。

/**
 * ターミナルの番号と、常駐側の handle の対応。
 *
 * 配置を預けるときに要る。番号はアプリを起こすたびに振り直されるので、**そのまま預けても
 * 次の起動では何も指さない**（`paradisTerminalLayout.ts`）。
 */
const handles = new Map<number, number>();

/** 番号に handle を結び付ける。器ができた時点で呼ぶ。 */
export function paradisRememberHandle(id: number, handle: number): void {
	handles.set(id, handle);
}

export function paradisForgetHandle(id: number): void {
	handles.delete(id);
}

export function paradisHandleOf(id: number): number | undefined {
	return handles.get(id);
}

/** このプロセスが引き取り済みの handle。引き取り直しで二重に載せないために使う。 */
export function paradisKnownHandles(): ReadonlySet<number> {
	return new Set(handles.values());
}

/** handle から番号を引く（{@link paradisHandleOf} の逆）。 */
export function paradisIdOfHandle(handle: number): number | undefined {
	for (const [id, known] of handles) {
		if (known === handle) {
			return id;
		}
	}
	return undefined;
}
