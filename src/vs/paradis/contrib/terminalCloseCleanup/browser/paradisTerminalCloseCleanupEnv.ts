/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「閉じたときに裏のプロセスを止める」（W2-32）の設定を、ターミナルを作るときの env へ写す。
//
// pty ホスト（SSH 先・常駐を含む）は設定を読めないので、ターミナルごとに env の印で渡す。
// 設定の変更は、その後に開いたターミナルから効く。

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { paradisApplyCloseCleanupPreference, PARADIS_TERMINAL_STOP_BACKGROUND_ON_CLOSE } from '../common/paradisTerminalCloseCleanup.js';

/**
 * ターミナルを作る直前に呼ぶ（`paradisPrepareTerminalPaneEnv` から）。ターミナルの生成を壊さない
 * よう、ここからは投げない。拡張が作る疑似ターミナルなど、プロセスを持たないものは触らない。
 */
export function paradisPrepareTerminalCloseCleanupEnv(instantiationService: IInstantiationService, shellLaunchConfig: IShellLaunchConfig): void {
	if (shellLaunchConfig.customPtyImplementation || shellLaunchConfig.attachPersistentProcess) {
		return;
	}
	try {
		const stopBackground = instantiationService.invokeFunction(accessor => accessor.get(IConfigurationService).getValue<boolean>(PARADIS_TERMINAL_STOP_BACKGROUND_ON_CLOSE)) !== false;
		if (stopBackground && !shellLaunchConfig.env) {
			return;
		}
		shellLaunchConfig.env ??= {};
		paradisApplyCloseCleanupPreference(shellLaunchConfig.env, stopBackground);
	} catch {
		// 設定を読めなくても既定（止める）のまま作る。
	}
}
