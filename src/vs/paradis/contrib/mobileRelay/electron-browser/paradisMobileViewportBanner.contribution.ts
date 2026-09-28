/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スマホの画面に合わせて縮めている PC のターミナルに「スマホ表示に合わせて縮小中」と［PC の幅に戻す］を出す
// （W2-19、Q115 A）。縮めるのも戻すのもモバイル連携の provider で、ここは表示を付けるだけ。
//
// - エディタ領域のターミナル: 共有ドットと同じ重ね合わせの口（paradisRegisterEditorTerminalOverlay）に乗る。
//   タブを切り替えると対象のターミナルが差し替わる
// - パネルのターミナル: terminal contribution としてターミナルの wrapper に付ける。エディタ領域へ
//   移ったターミナルでは出さない（上の口と二重に出さない）
//
// 上流のファイルには手を入れない（PARA-PATCH なし）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalContribution } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { registerTerminalContribution, type ITerminalContributionContext } from '../../../../workbench/contrib/terminal/browser/terminalExtensions.js';
import { paradisRegisterEditorTerminalOverlay } from '../../agentBrowser/browser/paradisPaneIndicator.js';
import { createParadisMobileViewportBanner } from '../browser/paradisMobileViewportBannerView.js';
import { paradisMobileTerminalViewportStatus } from '../common/paradisMobileTerminalViewportStatus.js';

class ParadisMobileViewportEditorBannerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisMobileViewportBanner';

	constructor() {
		super();
		this._register(paradisRegisterEditorTerminalOverlay(container => createParadisMobileViewportBanner(container, paradisMobileTerminalViewportStatus)));
	}
}

class ParadisMobileViewportPanelBannerContribution extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.paradisMobileViewportBanner';

	constructor(ctx: ITerminalContributionContext) {
		super();
		const banner = createParadisMobileViewportBanner(ctx.instance.domElement, paradisMobileTerminalViewportStatus);
		this._register({ dispose: () => banner.dispose() });
		const update = () => banner.setInstance(ctx.instance.target === TerminalLocation.Editor ? undefined : ctx.instance.instanceId);
		this._register(ctx.instance.onDidChangeTarget(update));
		update();
	}
}

registerWorkbenchContribution2(ParadisMobileViewportEditorBannerContribution.ID, ParadisMobileViewportEditorBannerContribution, WorkbenchPhase.AfterRestored);
registerTerminalContribution(ParadisMobileViewportPanelBannerContribution.ID, ParadisMobileViewportPanelBannerContribution);
