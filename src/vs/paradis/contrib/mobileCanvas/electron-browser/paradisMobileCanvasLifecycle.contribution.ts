/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 消えたターミナルのアタッチを台帳から落とす。
//
// アタッチ台帳は shared process にあり、ターミナルの生死を知らない。放っておくと閉じた
// ターミナル分のエントリが残り続け、アタッチUIに「別のペインが使用中: <生のトークン>」という
// 実体のない行が並ぶ。
//
// ペイントークンの表は各ウィンドウのrendererが持つので、ここもrenderer側のcontributionとして
// 動かす。**自分のウィンドウで実際に消えたトークンだけ**を落とし、「見当たらない＝消えた」とは
// 判定しない（他ウィンドウのペインを巻き添えで解除してしまうため）。

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IParadisPaneTokenService } from '../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisMobileCanvasModel } from './paradisMobileCanvasModel.js';

class ParadisMobileCanvasLifecycle extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'paradis.mobileCanvas.lifecycle';

	/** このウィンドウで直近に生きていたペイントークン。差分を取るためだけに持つ。 */
	private _knownTokens: ReadonlySet<string>;

	constructor(
		@IParadisPaneTokenService private readonly paneTokenService: IParadisPaneTokenService,
		@IParadisMobileCanvasModel private readonly mobileCanvasModel: IParadisMobileCanvasModel,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this._knownTokens = this._currentTokens();
		this._register(this.paneTokenService.onDidChange(() => this._reconcile()));
	}

	private _currentTokens(): ReadonlySet<string> {
		return new Set(this.paneTokenService.listPaneTokens().map(entry => entry.token));
	}

	private _reconcile(): void {
		const current = this._currentTokens();
		const vanished = [...this._knownTokens].filter(token => !current.has(token));
		this._knownTokens = current;
		for (const token of vanished) {
			// 同じPTYを新しいインスタンスへ付け替えた場合、トークンは表に残るのでここには来ない。
			// ここへ来るのはターミナルが本当に終わったときだけ。
			this.mobileCanvasModel.detach(token).catch(error => {
				// 端末が外れないだけで作業は続けられるので、失敗しても黙って落とすに留める。
				this.logService.warn('[paradis-mobile-canvas] could not detach a closed terminal pane', error);
			});
		}
	}
}

registerWorkbenchContribution2(ParadisMobileCanvasLifecycle.ID, ParadisMobileCanvasLifecycle, WorkbenchPhase.AfterRestored);
