/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IBrowserViewModel } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditor, BrowserEditorContribution } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from './paradisAgentBrowserTabsService.js';
import { paradisShareButtonCount, paradisShareButtonEntries } from './paradisBrowserShareCount.js';
import { paradisIsShareMarkRemoved } from './paradisBrowserShareMark.js';

/**
 * そのブラウザエディタのページが1つ以上のペインと共有中かどうか。エディタごとの context key
 * （ParadisBrowserShareStateFeature）なので、分割した画面でもツールバーごとに自分のページの状態が出る。
 */
export const PARADIS_ACTIVE_PAGE_SHARED = new RawContextKey<boolean>('paradisActivePageShared', false, localize('paradis.activePageShared', "Whether the page of this integrated browser editor is shared with a terminal pane."));

/**
 * そのブラウザエディタのページが共有中かを、エディタごとの context key に出す。ツールバーの共有ボタンの
 * 表示（共有する／共有中）はこれで決まる。全体で 1 つの key にすると、分割した画面でアクティブな別の
 * タブの状態が、押そうとしているタブのツールバーに出てしまう。
 *
 * 共有中のページから共有の印（upstream の agent audience。ページの枠の表示に使われる）だけが外れたときは、
 * 印を付け直す。共有の正は para-browser の台帳で、ゲートウェイは印を見ずにつなぐため、印だけ外れると
 * 「枠は消えたがエージェントは操作できる」食い違いになる。
 */
export class ParadisBrowserShareStateFeature extends BrowserEditorContribution {
	private readonly _shared: IContextKey<boolean>;

	constructor(
		editor: BrowserEditor,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IParadisAgentBrowserBindingModel private readonly bindingModel: IParadisAgentBrowserBindingModel,
		@IParadisAgentBrowserTabsService private readonly tabsService: IParadisAgentBrowserTabsService,
	) {
		super(editor);
		this._shared = PARADIS_ACTIVE_PAGE_SHARED.bindTo(contextKeyService);
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		// ボタンに出す数と同じ数え方にする（Copilot だけと共有したページも共有中）。ツールバーは表示するアクションが
		// 入れ替わるときに幅を測り直すので、▾ が出る・消えるときに必ず入れ替わるようにする
		const update = () => this._shared.set(paradisShareButtonCount(paradisShareButtonEntries(this.bindingModel.getPageShares(model.id), model.sharingState)) > 0);
		store.add(this.bindingModel.onDidChange(update));
		store.add(model.onDidChangeSharingState(state => {
			update();
			if (paradisIsShareMarkRemoved(state) && this.bindingModel.getBindingsForPage(model.id).length > 0) {
				void this._restoreShareMark(model, store);
			}
		}));
		update();
	}

	private async _restoreShareMark(model: IBrowserViewModel, store: DisposableStore): Promise<void> {
		// 共有を外す操作の途中（台帳が先に減って、続けて印を下ろす）と取り違えないよう、台帳を取り直してから見る
		await this.bindingModel.refresh(true);
		if (!store.isDisposed && paradisIsShareMarkRemoved(model.sharingState) && this.bindingModel.getBindingsForPage(model.id).length > 0) {
			await this.tabsService.restoreShareMark(model);
		}
	}

	override onModelDetached(): void {
		this._shared.reset();
	}
}
