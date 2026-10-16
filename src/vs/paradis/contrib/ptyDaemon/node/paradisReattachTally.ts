/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 起動したときに常駐から引き取れた本数と、保存した画面から起こし直した本数を数えて、ウィンドウへ
// 渡す（ウィンドウが Sentry へ送る。pty ホストには Sentry が無い）。
//
// 数えるのは pty ホストの中。引き取り（`paradisAdoptIntoPtyService`）も起こし直しの番号も、ここに
// しか無いため。ウィンドウは複数あるので、引き取りの数は最初に聞いたウィンドウにだけ渡す
// （同じ起動を何度も数えない）。起こし直しはワークスペースごとにそのウィンドウが起こすので、聞いてきた
// ウィンドウのワークスペースの分を、前に渡した後の分だけ渡す。

import { IParadisReattachTally } from '../../../../platform/terminal/common/paradisReattachTally.js';

interface IAdoption {
	readonly reachable: boolean;
	readonly adopted: number;
	readonly skipped: number;
}

let adoption: IAdoption | undefined;
let adoptionTaken = false;
const attachedIds = new Set<number>();
/** ワークスペースごとの、起こし直したがまだ渡していない pty の番号。 */
const revivedByWorkspace = new Map<string, number[]>();

/** 常駐から引き取った結果。常駐を使っていない pty ホストでは呼ばれない。 */
export function paradisRecordAdoption(value: IAdoption): void {
	adoption = value;
	adoptionTaken = false;
}

/** 保存した画面から起こし直した pty。 */
export function paradisNoteRevived(workspaceId: string, id: number): void {
	const ids = revivedByWorkspace.get(workspaceId) ?? [];
	ids.push(id);
	revivedByWorkspace.set(workspaceId, ids);
}

/** 窓が繋ぎに来た pty。起こし直したのに誰も繋ぎに来ないもの（＝複製）を見分けるのに使う。 */
export function paradisNoteAttached(id: number): void {
	attachedIds.add(id);
}

/** 前に渡してからの分を渡す。常駐を使っていない pty ホストでは undefined。 */
export function paradisTakeReattachTally(workspaceId: string): IParadisReattachTally | undefined {
	if (!adoption) {
		return undefined;
	}
	const revived = revivedByWorkspace.get(workspaceId) ?? [];
	revivedByWorkspace.delete(workspaceId);
	const firstTake = !adoptionTaken;
	adoptionTaken = true;
	return {
		firstTake,
		reachable: adoption.reachable,
		adopted: firstTake ? adoption.adopted : 0,
		leftBehind: firstTake ? adoption.skipped : 0,
		revived: revived.length,
		revivedUnclaimed: revived.filter(id => !attachedIds.has(id)).length,
	};
}

/** テスト用。 */
export function paradisResetReattachTally(): void {
	adoption = undefined;
	adoptionTaken = false;
	attachedIds.clear();
	revivedByWorkspace.clear();
}
