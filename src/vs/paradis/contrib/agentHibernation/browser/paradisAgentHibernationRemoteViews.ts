/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 休止（G-03）とモバイルリレーをつなぐ口（ウィンドウごと）。スマホが開いているターミナルは休止させず、
// 休止中のターミナルをスマホが開いたら起こす。休止そのもの（止める・再開する）は terminalResumeBanner の
// contribution が持つ。モバイルリレーの部品は DI を通さずに作られるので、ここはモジュールの状態で持つ
// （エディタのターミナルに重ねる部品の登録 `paradisRegisterEditorTerminalOverlay` と同じ形）。

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

const viewing = new Set<number>();
const lastViewAt = new Map<number, number>();
let wakeHandler: ((instanceId: number) => void) | undefined;

/** スマホがそのターミナルを開いた（`true`）・どのスマホも見なくなった（`false`）。開いたときは、休止中なら起こす。 */
export function paradisNoteRemoteTerminalViewing(instanceId: number, isViewing: boolean): void {
	lastViewAt.set(instanceId, Date.now());
	if (isViewing) {
		viewing.add(instanceId);
		wakeHandler?.(instanceId);
	} else {
		viewing.delete(instanceId);
	}
}

/** ターミナルが閉じられた。 */
export function paradisForgetRemoteTerminalViewing(instanceId: number): void {
	viewing.delete(instanceId);
	lastViewAt.delete(instanceId);
}

export function paradisIsRemoteTerminalViewing(instanceId: number): boolean {
	return viewing.has(instanceId);
}

/** スマホが最後にそのターミナルを見ていた時刻（今も見ていれば今）。 */
export function paradisLastRemoteTerminalViewAt(instanceId: number): number | undefined {
	return viewing.has(instanceId) ? Date.now() : lastViewAt.get(instanceId);
}

/** 休止中のターミナルを起こす口を受け持つ（1 つだけ）。 */
export function paradisSetHibernationWakeHandler(handler: (instanceId: number) => void): IDisposable {
	wakeHandler = handler;
	return toDisposable(() => {
		if (wakeHandler === handler) {
			wakeHandler = undefined;
		}
	});
}
