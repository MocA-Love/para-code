/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 端末のプロセスの起動を、期限つきで待つ。
//
// **`processReady` は失敗しても解決も拒否もしない。** 起動に失敗した端末や、起動の前に閉じた端末では
// 永久に待ち続け、続く処理（プリセットの残りのタスク・レイアウトの残りの枠）が始まらない。
// ここでは閉じた・期限を過ぎた、を見分けて返す。
//
// `onExit` とは競わせない。シェル統合の差し込みで起動に失敗した端末は、upstream が `onExit` を出した後に
// シェル統合を外して起こし直し、そのまま ready になる（`terminalInstance.ts` の `_onProcessExit`）。
// 起動の失敗（cwd が無い等）は閉じられないまま残るので、期限で拾う。

import { raceTimeout } from '../../base/common/async.js';
import { Event } from '../../base/common/event.js';

/** 起動を待つ上限の既定。常駐の起動待ち（最大 10 秒）や SSH 先の起動でも正しく遅くなるので長めに取る。 */
export const PARADIS_PROCESS_READY_TIMEOUT_MS = 30_000;

/** 待つ相手（`ITerminalInstance` のうち使うところ）。workbench を import しないための形。 */
export interface IParadisProcessReadyTarget {
	readonly processReady: Promise<void>;
	readonly isDisposed: boolean;
	readonly onDisposed: Event<unknown>;
}

/**
 * `ready`: 起動した。`disposed`: 起動の前（または待っている間）に閉じられた。`timeout`: 期限を過ぎた。
 * `processReady` が拒否したときは、そのまま投げる（今までどおり）。
 */
export type ParadisProcessReadyResult = 'ready' | 'disposed' | 'timeout';

/**
 * 端末のプロセスの起動を待つ。閉じられたら・期限を過ぎたら、待つのをやめて理由を返す。
 *
 * @param timeoutMs 期限。`Infinity` なら期限を付けず、閉じられたときだけやめる（遅れて繋がる相手を
 * 期限で見捨てると困るところ向け）。
 */
export async function paradisWaitForProcessReady(instance: IParadisProcessReadyTarget, timeoutMs: number = PARADIS_PROCESS_READY_TIMEOUT_MS): Promise<ParadisProcessReadyResult> {
	if (instance.isDisposed) {
		return 'disposed';
	}
	const disposed = Event.toPromise(instance.onDisposed);
	try {
		const settled = Promise.race([
			instance.processReady.then((): ParadisProcessReadyResult => 'ready'),
			disposed.then((): ParadisProcessReadyResult => 'disposed'),
		]);
		if (!Number.isFinite(timeoutMs)) {
			return await settled;
		}
		return (await raceTimeout(settled, timeoutMs)) ?? 'timeout';
	} finally {
		disposed.cancel();
	}
}
