/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// shared process の中で、ボードの接続口が受け付けた「工程の終わりの報告」を、ほかの機能（Bot の項目）へ渡す。
// 接続口と Bot はそれぞれ別に登録されるので、モジュールに 1 つの Emitter でつなぐ（paradisAgentHookBus と同じ形）。

import { Emitter, Event } from '../../../../base/common/event.js';
import type { IParadisTaskBoardStepCompleted } from './paradisTaskBoardBridgeService.js';

const emitter = new Emitter<IParadisTaskBoardStepCompleted>();

/** ボードが受け付けた工程の終わりの報告（shared process の中だけ）。 */
export const onParadisTaskBoardStepCompleted: Event<IParadisTaskBoardStepCompleted> = emitter.event;

/** 接続口の登録だけが呼ぶ。 */
export function paradisFireTaskBoardStepCompleted(event: IParadisTaskBoardStepCompleted): void {
	emitter.fire(event);
}
