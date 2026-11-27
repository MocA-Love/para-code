/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Bot の会話のペインは、タブを閉じても止めずに隠す（報告書の D4 (a)）。
//
// - このウィンドウの Bot の会話のペイン（instanceId）を「閉じても隠すターミナル」の台帳
//   （workspaceSwitch/browser/paradisTerminalHideOnClose.ts）に控える。起動したときと、Bot の様子が変わったときに
//   ParadisBotsWindowWorker が足す。upstream の `terminalEditorInput.ts` の `confirm()` の PARA-PATCH がその台帳を読み、
//   「実行中のプロセスを終了しますか？」を出さずに閉じてよいと答える。
// - 閉じる直前（エディタグループの onWillCloseEditor）に入力からターミナルを外し（dispose しても終わらない）、閉じ終えて
//   から upstream の裏の置き場所（`ITerminalService.moveToBackground`）へ移す。開き直すときは
//   {@link paradisShowHiddenBotPane} で戻す。

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';

/** 閉じて裏に回した Bot の会話のペイン。 */
const hiddenPanes = new Map<number, { readonly instance: ITerminalInstance; readonly listener: IDisposable }>();

/** 閉じて裏に回したペインとして控える。 */
export function paradisMarkBotPaneHidden(instance: ITerminalInstance): void {
	forgetHidden(instance.instanceId);
	// 一度だけ聞く（終わった時点で外れる）
	const listener = Event.once(instance.onDisposed)(() => forgetHidden(instance.instanceId));
	hiddenPanes.set(instance.instanceId, { instance, listener });
}

function forgetHidden(instanceId: number): void {
	hiddenPanes.get(instanceId)?.listener.dispose();
	hiddenPanes.delete(instanceId);
}

export function paradisIsBotPaneHidden(instanceId: number): boolean {
	const instance = hiddenPanes.get(instanceId)?.instance;
	return instance !== undefined && !instance.isDisposed;
}

/** 裏に回したペイン（再読み込みの前に閉じる）。 */
export function paradisHiddenBotPanes(): ITerminalInstance[] {
	return [...hiddenPanes.values()].map(entry => entry.instance).filter(instance => !instance.isDisposed);
}

/** 裏に回したペインなら、エディタのタブへ戻す。戻したら true。 */
export async function paradisShowHiddenBotPane(terminalService: Pick<ITerminalService, 'showBackgroundTerminal'>, instance: ITerminalInstance): Promise<boolean> {
	if (!paradisIsBotPaneHidden(instance.instanceId)) {
		return false;
	}
	forgetHidden(instance.instanceId);
	await terminalService.showBackgroundTerminal(instance);
	return true;
}

/** テスト用に台帳を空にする。 */
export function paradisResetBotPaneHideForTest(): void {
	for (const instanceId of [...hiddenPanes.keys()]) {
		forgetHidden(instanceId);
	}
}
