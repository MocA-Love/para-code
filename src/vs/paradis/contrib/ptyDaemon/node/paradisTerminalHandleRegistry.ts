/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** 引き取る相手。常駐が抱えている1本を名指しする。 */
export interface IParadisAdoptTarget {
	readonly handle: number;
	readonly pid: number;
	readonly title: string;
	/**
	 * すでに終わっていたなら、その終わり方。
	 *
	 * **イベントを待っても来ない。** 閉じている間に走り切ったものは、繋ぎ直したときには
	 * とっくに終わっている。これを渡さないと、器は生きているつもりのまま終了を一度も出さず、
	 * **戻ってきて結果を読むというこの機能の主目的の経路で、肝心の答えが落ちる**。
	 */
	readonly exited: { readonly code: number | undefined } | undefined;
}

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
