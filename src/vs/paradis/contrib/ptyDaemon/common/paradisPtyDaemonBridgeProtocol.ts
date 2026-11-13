/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// main と橋渡しプロセス（paradisPtyDaemonBridgeMain.ts）の間でやり取りする、窓への口の確認の形。
//
// main は橋の確認が通ってから窓へポートを渡す。先に渡すと、確認が通らずに橋がポートを閉じても
// renderer は受け取った口で直結を完成させてしまい、ターミナルの操作が返らなくなる。

/**
 * 常駐の名乗り合いの結果。
 * - `genuine`: 台帳の常駐の本物だった
 * - `refused`: 本物ではない（名乗りを断られた・台帳に記録が無い・繋がらない）
 * - `timeout`: 接続は受けたが期限までに答えなかった（固まった常駐）
 */
export type ParadisDaemonCheck = 'genuine' | 'refused' | 'timeout';

/** main から橋へ、ポートと一緒に送る。 */
export interface IParadisBridgeCheckRequest {
	readonly id: number;
	/** 名乗りを待つ上限（ミリ秒）。main が自分の名乗りで使ったものと同じ。 */
	readonly handshakeTimeout: number;
}

/** 橋から main へ。`id` は受け取った要求のもの。 */
export interface IParadisBridgeCheckVerdict {
	readonly type: 'paradisBridgeCheckVerdict';
	readonly id: number;
	readonly check: ParadisDaemonCheck;
}

export function paradisIsBridgeCheckRequest(value: unknown): value is IParadisBridgeCheckRequest {
	return typeof value === 'object' && value !== null
		&& typeof (value as IParadisBridgeCheckRequest).id === 'number'
		&& typeof (value as IParadisBridgeCheckRequest).handshakeTimeout === 'number';
}

export function paradisIsBridgeCheckVerdict(value: unknown): value is IParadisBridgeCheckVerdict {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const verdict = value as IParadisBridgeCheckVerdict;
	return verdict.type === 'paradisBridgeCheckVerdict' && typeof verdict.id === 'number'
		&& (verdict.check === 'genuine' || verdict.check === 'refused' || verdict.check === 'timeout');
}
