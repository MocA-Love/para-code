/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 共有したページ（またはエージェントが tab_id で使えるタブ）から開いたタブを、同じペインへ自動で共有する。
//
// 開いたタブは target=_blank のリンク・window.open・Ctrl/Cmd/中クリック・右クリックの「新しいタブで開く」で
// 開いたもの（別ウィンドウで開いたものを含む）。開いた元のタブは main が覚えていて（paradisCdpTargetService の
// getOpenerViewId）、ここでは新しいタブを見つけたら shared process に「元のタブを使えるペイン」を聞き、そのペイン
// それぞれへ許可を頼むだけ。許可してよいかは shared process が main に確かめ直す（renderer の言い分では広げない）。
// 孫（開いたタブから開いたタブ）も、開いたタブが許可済みなら同じく許可される。
//
// 許可は別枠の上限（PARADIS_OPENED_TAB_LIMIT）で数え、元のタブが使えなくなったら shared process が外す。
// ここで付けた共有の印（エージェントを共有相手に加えたもの）は、許可がすべて外れたら下ろし、ユーザーが印を
// 外したら（共有ボタン）許可も外す。

import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from './paradisAgentBrowserTabsService.js';

/** 共有の印が付いているか（await をまたいで読み直すので関数にする）。 */
function isShared(model: IBrowserViewModel): boolean {
	return model.sharingState === BrowserViewSharingState.Shared;
}

class ParadisAgentBrowserOpenedTabsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserOpenedTabs';

	/** 見たことのあるタブ（新しく開いたタブだけを扱う）。 */
	private readonly _seen = new Set<string>();
	private _ready = false;
	/** ここで共有の印を付けたタブ → その見張り。許可が付いたのを一度見たか（{@link _reconcile} が早すぎる下ろしをしない）。 */
	private readonly _marked = this._register(new DisposableMap<string, DisposableStore>());
	private readonly _grantSeen = new Set<string>();

	constructor(
		@IBrowserViewWorkbenchService private readonly _browserViews: IBrowserViewWorkbenchService,
		@IParadisAgentBrowserTabsService private readonly _tabs: IParadisAgentBrowserTabsService,
		@IParadisAgentBrowserBindingModel private readonly _bindingModel: IParadisAgentBrowserBindingModel,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._browserViews.onDidChangeBrowserViews(() => this._scan()));
		this._register(this._bindingModel.onDidChange(() => this._reconcile()));
		// 起動時にもう開いていたタブは扱わない（再読み込みの前の許可は shared process が外している）
		void this._browserViews.whenInitialized.then(() => {
			for (const id of this._browserViews.getKnownBrowserViews().keys()) {
				this._seen.add(id);
			}
			this._ready = true;
		});
	}

	private _scan(): void {
		if (!this._ready) {
			return;
		}
		const known = this._browserViews.getKnownBrowserViews();
		for (const id of [...this._seen]) {
			if (!known.has(id)) {
				this._seen.delete(id);
				this._grantSeen.delete(id);
				this._marked.deleteAndDispose(id);
			}
		}
		for (const [id, input] of known) {
			if (!this._seen.has(id)) {
				this._seen.add(id);
				void this._shareOpenedTab(input).catch(error => this._logService.debug('[ParadisAgentBrowserOpenedTabs] could not share an opened tab', error));
			}
		}
	}

	private async _shareOpenedTab(input: BrowserEditorInput): Promise<void> {
		const tokens = await this._bindingModel.openerPanesOf(input.id);
		if (tokens.length === 0) {
			return;
		}
		const model = await input.resolve();
		const sharedBefore = isShared(model);
		let granted = false;
		for (const token of tokens) {
			const result = await this._tabs.shareOpenedTab(token, input);
			granted = granted || result === 'granted';
			if (result === 'limitReached') {
				this._logService.debug('[ParadisAgentBrowserOpenedTabs] a pane reached the limit of tabs opened from its pages; not sharing the new tab');
			}
		}
		if (granted && !sharedBefore && isShared(model) && this._seen.has(input.id)) {
			this._watchMarked(input.id, model);
		}
	}

	/** ここで付けた共有の印を、ユーザーが外したら（共有ボタン）許可も外す。 */
	private _watchMarked(viewId: string, model: IBrowserViewModel): void {
		const store = new DisposableStore();
		store.add(model.onDidChangeSharingState(state => {
			if (state !== BrowserViewSharingState.Shared && this._marked.has(viewId)) {
				this._marked.deleteAndDispose(viewId);
				this._grantSeen.delete(viewId);
				for (const token of this._bindingModel.getAgentTabOwnersForPage(viewId)) {
					void this._bindingModel.revokeAgentTab(token, viewId);
				}
			}
		}));
		this._marked.set(viewId, store);
		this._reconcile();
	}

	/** 許可がすべて外れた（元のタブの共有を外した・閉じた）タブの、ここで付けた共有の印を下ろす。 */
	private _reconcile(): void {
		for (const viewId of [...this._marked.keys()]) {
			const inUse = this._bindingModel.getAgentTabOwnersForPage(viewId).length > 0 || this._bindingModel.getBindingsForPage(viewId).length > 0;
			if (inUse) {
				this._grantSeen.add(viewId);
				continue;
			}
			if (!this._grantSeen.has(viewId)) {
				// 許可の控えがまだ届いていない
				continue;
			}
			this._marked.deleteAndDispose(viewId);
			this._grantSeen.delete(viewId);
			const model = this._browserViews.getKnownBrowserViews().get(viewId)?.model;
			if (model?.sharingState === BrowserViewSharingState.Shared) {
				void model.setSharedWithAgent(false).catch(error => this._logService.debug('[ParadisAgentBrowserOpenedTabs] could not unshare an opened tab', error));
			}
		}
	}
}

registerWorkbenchContribution2(ParadisAgentBrowserOpenedTabsContribution.ID, ParadisAgentBrowserOpenedTabsContribution, WorkbenchPhase.AfterRestored);
