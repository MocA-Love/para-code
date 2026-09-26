/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// OS 通知（エージェントの完了・許可待ち・質問）をクリックしたときに、通知の元になったペインまで
// 連れていく。通知はペインを持っているウィンドウの renderer が出す（ほかのウィンドウのペインは
// paneTokenService で解決できず通知しない）ので、クリックの結果も必ずそのウィンドウに返ってくる。
// ここではそのウィンドウを前面に出し、別スペースならスペースを切り替え、ターミナルへフォーカスする。

import { getWindow } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisWorkspaceSwitchService } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';

export interface IParadisNotificationRevealServices {
	readonly hostService: Pick<IHostService, 'focus'>;
	readonly terminalService: Pick<ITerminalService, 'getInstanceFromId' | 'focusInstance'>;
	readonly workspaceSwitchService: Pick<IParadisWorkspaceSwitchService, 'activeStateKey' | 'switchToStateKey'>;
}

/** ターミナルが今どのウィンドウに描かれているか。まだ一度も描かれていなければメインウィンドウ。 */
function windowOf(instance: ITerminalInstance | undefined): Window {
	const element = instance?.domElement;
	return element ? getWindow(element) : mainWindow;
}

/**
 * 通知のクリックで、ペイン（`instanceId` のターミナル）まで移動してフォーカスする。
 *
 * 1. ペインのあるウィンドウを前面に出す（通知をクリックしただけではアプリが前面に来るだけで、
 *    どのウィンドウかは決まらない）
 * 2. ペインが別スペースにあるならそのスペースへ切り替える（`stateKey` が無い = スペース外のペイン）
 * 3. ターミナルを開いてフォーカスする。切り替えでペインが補助ウィンドウへ移ることもあるので、
 *    最後にもう一度そのウィンドウを前面に出す
 */
export async function paradisRevealNotifiedPane(services: IParadisNotificationRevealServices, stateKey: string | undefined, instanceId: number): Promise<void> {
	const { hostService, terminalService, workspaceSwitchService } = services;
	const initialWindow = windowOf(terminalService.getInstanceFromId(instanceId));
	await hostService.focus(initialWindow, { mode: FocusMode.Force });

	if (stateKey !== undefined && stateKey !== workspaceSwitchService.activeStateKey) {
		await workspaceSwitchService.switchToStateKey(stateKey);
	}

	// スペースの切り替えでターミナルは退避所から戻ってくるので、切り替えの後で引き直す。
	const instance = terminalService.getInstanceFromId(instanceId);
	if (!instance || instance.isDisposed) {
		return;
	}
	await terminalService.focusInstance(instance);
	const finalWindow = windowOf(instance);
	if (finalWindow !== initialWindow) {
		await hostService.focus(finalWindow, { mode: FocusMode.Force });
	}
}
