/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * モバイルが「自分の画面で読める寸法」を申告してきたときの検証と調停。
 *
 * PTYの寸法は1組しか持てないため、同じターミナルを複数のモバイルが見ている場合は
 * どれか1つに決めるしかない。ここでは**最小に合わせる**（tmuxの`window-size smallest`
 * 相当）。最後に申告した端末に合わせる方式（`latest`）だと、狭い端末で見ている側が
 * 突然読めない幅になるため、全員が読める側へ倒す。
 *
 * 判定をprovider本体から切り出しているのは、実ターミナル・実リレーを立てずに
 * 調停規則だけをテストできるようにするため。
 */

/** 受け入れる寸法の範囲。壊れた値でPTYを潰さないための門番。 */
export const PARADIS_TERM_VIEWPORT_MIN_COLS = 20;
export const PARADIS_TERM_VIEWPORT_MIN_ROWS = 5;
export const PARADIS_TERM_VIEWPORT_MAX_COLS = 500;
export const PARADIS_TERM_VIEWPORT_MAX_ROWS = 300;

/**
 * モバイルが申告した画面寸法。
 *
 * `rows` は任意。桁だけ合わせて行数はPC側のままにする設定（PC側のターミナルが表示領域から
 * 縦にはみ出すのを避けたい人向け）があるため、行の申告が無い状態を型で表せるようにしてある。
 */
export interface IParadisMobileTerminalViewport {
	readonly cols: number;
	readonly rows?: number;
}

function isInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

/**
 * `attach` / `viewport` に載る寸法の妥当性。
 *
 * - 両方無い = 寸法合わせをしない／やめる。正当な指定として通す
 * - 桁だけ = 行数はPC側のまま。正当
 * - 行だけ・範囲外・非整数は不正として弾く（中途半端な値でPTYを resize しない）
 */
export function paradisIsValidTerminalViewportMessage(msg: { viewCols?: unknown; viewRows?: unknown }): boolean {
	if (msg.viewCols === undefined) {
		return msg.viewRows === undefined;
	}
	return isInRange(msg.viewCols, PARADIS_TERM_VIEWPORT_MIN_COLS, PARADIS_TERM_VIEWPORT_MAX_COLS)
		&& (msg.viewRows === undefined || isInRange(msg.viewRows, PARADIS_TERM_VIEWPORT_MIN_ROWS, PARADIS_TERM_VIEWPORT_MAX_ROWS));
}

/** 検証済みメッセージから寸法を取り出す（申告なしは `undefined`）。 */
export function paradisReadTerminalViewport(msg: { viewCols?: number; viewRows?: number }): IParadisMobileTerminalViewport | undefined {
	return msg.viewCols === undefined
		? undefined
		: { cols: msg.viewCols, ...(msg.viewRows === undefined ? {} : { rows: msg.viewRows }) };
}

/**
 * 同じターミナルを見ている全モバイルの申告から、PTYへ渡す寸法を決める。
 * 申告が1つも無ければ `undefined`（＝PC側の寸法へ戻す）。
 * 行数は申告した端末だけで決める（1台でも「行は合わせない」なら、その端末は行の決定に参加しない）。
 */
export function paradisResolveTerminalViewport(viewports: Iterable<IParadisMobileTerminalViewport | undefined>): IParadisMobileTerminalViewport | undefined {
	let cols: number | undefined;
	let rows: number | undefined;
	for (const viewport of viewports) {
		if (viewport === undefined) {
			continue;
		}
		cols = cols === undefined ? viewport.cols : Math.min(cols, viewport.cols);
		if (viewport.rows !== undefined) {
			rows = rows === undefined ? viewport.rows : Math.min(rows, viewport.rows);
		}
	}
	return cols === undefined ? undefined : { cols, ...(rows === undefined ? {} : { rows }) };
}
