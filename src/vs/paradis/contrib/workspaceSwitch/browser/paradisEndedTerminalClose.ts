/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 終わっていた端末のタブを閉じてよいかの待ちと判断（`paradisEndedTerminalRestore.contribution.ts` から使う）。

import { raceTimeout } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/** 閉じるかどうかの判断に要る切り替えの様子。 */
export interface IParadisEndedTerminalCloseSwitchState {
	readonly isSwitching: boolean;
	readonly onDidSwitchScope: Event<unknown>;
}

/**
 * 起こしかけたシェルの準備と、切り替えの終わりを待ってから、タブを閉じる。
 *
 * **どちらかが待ち時間を過ぎた、または待った後もまだ切り替えの途中なら、閉じない**（空のシェルのタブで
 * 残す。今まで通りの見え方で、失うものは無い）。切り替えの途中に閉じると、適用中の working set と
 * ぶつかる。準備が済んでいないシェルを破棄すると、準備の後始末が宙に浮く。
 *
 * @returns 閉じたか。
 */
export async function paradisCloseEndedTerminalWhenSafe(
	instance: Pick<ITerminalInstance, 'processReady' | 'isDisposed' | 'dispose'>,
	switchState: IParadisEndedTerminalCloseSwitchState,
	waitMs: number,
): Promise<boolean> {
	let timedOut = false;
	const onTimeout = () => { timedOut = true; };
	try {
		await raceTimeout(instance.processReady, waitMs, onTimeout);
		if (!timedOut && switchState.isSwitching) {
			const switched = Event.toPromise(switchState.onDidSwitchScope);
			try {
				await raceTimeout(switched, waitMs, onTimeout);
			} finally {
				switched.cancel();
			}
		}
	} catch {
		// 準備に失敗したシェルは upstream が畳む。閉じる相手が居ないだけ。
		return false;
	}
	if (timedOut || switchState.isSwitching || instance.isDisposed) {
		return false;
	}
	instance.dispose(TerminalExitReason.User);
	return true;
}
