/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルごとの、受け付けた最後の OSC 7501 の状態（このウィンドウの端末が読んだもの）。ペインの状態の帳簿
// （IParadisAgentStatusStore）は shared process から 2 秒ごとに取り直すので、許可の画面が出た直後はまだ古い。
// Antigravity CLI へ文を打つ直前の確かめ（paradisAntigravitySendBlock）は、この値も見て間を埋める。

import { IParadisProgramStatus } from '../common/paradisProgramStatus.js';

const latest = new Map<number, IParadisProgramStatus>();

/** 受け付けた状態を shared process へ渡すときに呼ぶ（paradisProgramStatus.contribution.ts）。 */
export function paradisNoteLatestProgramStatus(instanceId: number, status: IParadisProgramStatus): void {
	latest.set(instanceId, status);
}

/** ターミナルを閉じたときに呼ぶ。 */
export function paradisForgetLatestProgramStatus(instanceId: number): void {
	latest.delete(instanceId);
}

/** そのターミナルで受け付けた最後の状態。 */
export function paradisLatestProgramStatus(instanceId: number): IParadisProgramStatus | undefined {
	return latest.get(instanceId);
}
