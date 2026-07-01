/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';

const CONFIG_KEY_ENABLED = 'paradis.window.transparency.enabled';
const CONFIG_KEY_OPACITY = 'paradis.window.transparency.opacity';

/**
 * `paradis.window.transparency.*` 設定を実際のウィンドウ不透明度へ反映するcontribution。
 * Electronの `BrowserWindow.setOpacity()` を直接使う都合上、通常のPara Codeデスクトップウィンドウでのみ有効。
 */
class ParadisWindowTransparencyContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisWindowTransparency';

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super();

		this.applyWindowOpacity();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_KEY_ENABLED) || e.affectsConfiguration(CONFIG_KEY_OPACITY)) {
				this.applyWindowOpacity();
			}
		}));
	}

	private applyWindowOpacity(): void {
		const enabled = this.configurationService.getValue<boolean>(CONFIG_KEY_ENABLED);
		const opacity = this.configurationService.getValue<number>(CONFIG_KEY_OPACITY);

		this.nativeHostService.setWindowOpacity(enabled ? opacity : 1);
	}
}

registerWorkbenchContribution2(ParadisWindowTransparencyContribution.ID, ParadisWindowTransparencyContribution, WorkbenchPhase.AfterRestored);
