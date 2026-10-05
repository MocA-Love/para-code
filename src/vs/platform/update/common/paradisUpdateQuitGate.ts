/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「再起動して更新」の直前に挟む関門の登録口。
//
// 更新の入口（メニュー・タイトルバー・コマンド・拡張機能の画面など）はどれも main の
// `AbstractUpdateService.quitAndInstall()` に集まる。そこへ PARA-PATCH で1行だけ
// `paradisPassUpdateQuitGate()` を足し、中身（ウィンドウへの問い合わせ・確認・止める処理）は
// `src/vs/paradis/contrib/updateTerminals/electron-main/` から登録する。
//
// ここで確認するのは、終了が始まる**前**でなければならないため。renderer の veto で止めると、
// 先に問い合わせたウィンドウだけが閉じてしまう（`lifecycleMainService` はウィンドウを1つずつ
// 閉じる）。

import { IDisposable, toDisposable } from '../../../base/common/lifecycle.js';

/** 関門の中身。`false` を返すと更新を取りやめる（状態は Ready のまま）。 */
export interface IParadisUpdateQuitGate {
	confirmBeforeQuitAndInstall(): Promise<boolean>;
}

let registered: IParadisUpdateQuitGate | undefined;
let pending: Promise<boolean> | undefined;

export function paradisSetUpdateQuitGate(gate: IParadisUpdateQuitGate): IDisposable {
	registered = gate;
	return toDisposable(() => {
		if (registered === gate) {
			registered = undefined;
		}
	});
}

/**
 * 関門を通す。登録が無い・中で失敗したときは今までどおり更新を続ける（関門の不具合で更新が
 * 二度とできなくなるのを避ける）。
 *
 * 確認を出している間にもう一度押されたら、同じ答えを待つ（確認を2つ重ねない）。
 */
export function paradisPassUpdateQuitGate(): Promise<boolean> {
	const gate = registered;
	if (!gate) {
		return Promise.resolve(true);
	}
	if (pending) {
		// 2回目の呼び出しは、1回目が通ったときに二重に終了を始めないよう、通さない。
		return pending.then(() => false);
	}
	const current = gate.confirmBeforeQuitAndInstall().then(passed => passed, () => true);
	pending = current;
	return current.finally(() => {
		if (pending === current) {
			pending = undefined;
		}
	});
}
