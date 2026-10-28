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
// ここで付けた共有の印（エージェントを共有相手に加えたもの）は shared process の台帳に覚えさせ、許可がすべて
// 外れたら下ろす。台帳と許可はどちらも shared process の状態なので、renderer の控えの遅れや再読み込みをまたいでも
// 印だけが残らない。ユーザーが印を外したら（共有ボタン）許可も外す。

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ISharedProcessService } from '../../../../platform/ipc/electron-browser/services.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserViewSharingState, IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { PARADIS_AGENT_BROWSER_CHANNEL } from '../common/paradisAgentBrowser.js';
import { PARADIS_OPENED_TAB_BURST_RETRIES, PARADIS_OPENED_TAB_BURST_WINDOW_MS } from '../common/paradisAgentBrowserTabs.js';
import { IParadisAgentBrowserBindingModel } from './paradisAgentBrowserBindingModel.js';
import { IParadisAgentBrowserTabsService } from './paradisAgentBrowserTabsService.js';
import { paradisIsShareMarkRemoved } from './paradisBrowserShareMark.js';

/** 共有の印が付いているか（await をまたいで読み直すので関数にする）。 */
function isShared(model: IBrowserViewModel): boolean {
	return model.sharingState === BrowserViewSharingState.Shared;
}

/** shared process の印の台帳の 1 件。 */
interface IOpenedTabShareMark {
	readonly viewId: string;
	readonly inUse: boolean;
}

export class ParadisAgentBrowserOpenedTabsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.paradisAgentBrowserOpenedTabs';

	/** 見たことのあるタブ（新しく開いたタブだけを扱う）。 */
	private readonly _seen = new Set<string>();
	private _ready = false;
	/** ここで共有の印を付けたタブ → ユーザーが印を外すのの見張り（このウィンドウの今の世代の分だけ）。 */
	private readonly _watchers = this._register(new DisposableMap<string, DisposableStore>());
	/** 連続の上限で断られたタブ → 頼み直しの時計（タブが閉じたら止める）。 */
	private readonly _retries = this._register(new DisposableMap<string>());
	/** ユーザーが共有の印を外したタブ。もう自動では共有しない（頼み直しでも共有を戻さない）。 */
	private readonly _unsharedByUser = new Set<string>();
	/** {@link _reconcile} の実行中か、実行中にもう一度頼まれたか。 */
	private _reconciling: Promise<void> | undefined;
	private _reconcileAgain = false;

	constructor(
		@IBrowserViewWorkbenchService private readonly _browserViews: IBrowserViewWorkbenchService,
		@IParadisAgentBrowserTabsService private readonly _tabs: IParadisAgentBrowserTabsService,
		@IParadisAgentBrowserBindingModel private readonly _bindingModel: IParadisAgentBrowserBindingModel,
		@ISharedProcessService private readonly _sharedProcessService: ISharedProcessService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(this._browserViews.onDidChangeBrowserViews(() => this._scan()));
		this._register(this._bindingModel.onDidChange(() => this._reconcile()));
		// 起動時にもう開いていたタブは扱わない（再読み込みの前の許可は shared process が外している）。
		// 再読み込みの前に付けた印は、台帳と突き合わせて下ろす
		void this._browserViews.whenInitialized.then(() => {
			for (const id of this._browserViews.getKnownBrowserViews().keys()) {
				this._seen.add(id);
			}
			this._ready = true;
			this._reconcile();
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
				this._watchers.deleteAndDispose(id);
				this._retries.deleteAndDispose(id);
				this._unsharedByUser.delete(id);
			}
		}
		for (const [id, input] of known) {
			if (!this._seen.has(id)) {
				this._seen.add(id);
				void this._shareOpenedTab(input).catch(error => this._logService.debug('[ParadisAgentBrowserOpenedTabs] could not share an opened tab', error));
			}
		}
	}

	/**
	 * 開いたタブを、元のタブを使えるペインへ共有する。`retry` は連続の上限で断られたペインへの頼み直し（何回目か）。
	 * 頼み直しでも、元のタブを使えるペインは聞き直す（その間に共有が外れたペインへは広げない）。
	 */
	private async _shareOpenedTab(input: BrowserEditorInput, retry?: { readonly tokens: readonly string[]; readonly attempt: number }): Promise<void> {
		const openerPanes = await this._bindingModel.openerPanesOf(input.id);
		const tokens = retry === undefined ? openerPanes : retry.tokens.filter(token => openerPanes.includes(token));
		if (tokens.length === 0 || !this._seen.has(input.id) || this._unsharedByUser.has(input.id)) {
			return;
		}
		const model = await input.resolve();
		const sharedBefore = isShared(model);
		let granted = false;
		const bursting: string[] = [];
		for (const token of tokens) {
			if (this._unsharedByUser.has(input.id)) {
				return;
			}
			const result = await this._tabs.shareOpenedTab(token, input);
			granted = granted || result === 'granted';
			if (result === 'limitReached') {
				this._logService.debug('[ParadisAgentBrowserOpenedTabs] a pane reached the limit of tabs opened from its pages; not sharing the new tab');
			} else if (result === 'burstLimited') {
				bursting.push(token);
			}
		}
		const attempt = (retry?.attempt ?? 0) + 1;
		if (bursting.length > 0 && attempt <= PARADIS_OPENED_TAB_BURST_RETRIES && this._seen.has(input.id) && !this._unsharedByUser.has(input.id) && !this._store.isDisposed) {
			// 短い間に開きすぎた。窓が空いたら頼み直す
			this._retries.set(input.id, disposableTimeout(() => {
				this._retries.deleteAndDispose(input.id);
				void this._shareOpenedTab(input, { tokens: bursting, attempt }).catch(error => this._logService.debug('[ParadisAgentBrowserOpenedTabs] could not share an opened tab again', error));
			}, PARADIS_OPENED_TAB_BURST_WINDOW_MS));
		}
		if (granted && !sharedBefore && isShared(model) && this._seen.has(input.id)) {
			// 印を付けたことを台帳へ。台帳に載らなかったら、外し損ねないよう今下ろす
			if (await this._call<boolean>('markOpenedTabShared', [input.id]) === true) {
				this._watchUnshare(input.id, model);
			} else {
				await this._unshare(model);
			}
			this._reconcile();
		}
	}

	/** ここで付けた共有の印を、ユーザーが外したら（共有ボタン）許可も外す。 */
	private _watchUnshare(viewId: string, model: IBrowserViewModel): void {
		const store = new DisposableStore();
		store.add(model.onDidChangeSharingState(state => {
			if (paradisIsShareMarkRemoved(state) && this._watchers.has(viewId)) {
				this._watchers.deleteAndDispose(viewId);
				// 連続の上限で待っているペインへの頼み直しで、外した共有を戻さない
				this._retries.deleteAndDispose(viewId);
				this._unsharedByUser.add(viewId);
				for (const token of this._bindingModel.getAgentTabOwnersForPage(viewId)) {
					void this._bindingModel.revokeAgentTab(token, viewId);
				}
				void this._call('forgetOpenedTabShareMark', [viewId]);
			}
		}));
		this._watchers.set(viewId, store);
	}

	/**
	 * 台帳の印のうち、どのペインも使っていない（許可がすべて外れた）タブ・もう無いタブの印を下ろして台帳から外す。
	 * 判定は shared process の状態だけで行う（renderer の控えの遅れに左右されない）。
	 */
	private _reconcile(): void {
		if (!this._ready) {
			return;
		}
		if (this._reconciling) {
			this._reconcileAgain = true;
			return;
		}
		this._reconciling = this._doReconcile().catch(error => this._logService.debug('[ParadisAgentBrowserOpenedTabs] could not reconcile share marks', error)).finally(() => {
			this._reconciling = undefined;
			if (this._reconcileAgain && !this._store.isDisposed) {
				this._reconcileAgain = false;
				this._reconcile();
			}
		});
	}

	private async _doReconcile(): Promise<void> {
		const marks = await this._call<IOpenedTabShareMark[]>('listOpenedTabShareMarks', []);
		if (!Array.isArray(marks) || this._store.isDisposed) {
			return;
		}
		const known = this._browserViews.getKnownBrowserViews();
		for (const mark of marks) {
			const input = known.get(mark.viewId);
			if (mark.inUse && input) {
				continue;
			}
			this._watchers.deleteAndDispose(mark.viewId);
			const model = input?.model;
			if (model) {
				await this._unshare(model);
			}
			await this._call('forgetOpenedTabShareMark', [mark.viewId]);
		}
	}

	private async _unshare(model: IBrowserViewModel): Promise<void> {
		if (isShared(model)) {
			try {
				await model.setSharedWithAgent(false);
			} catch (error) {
				this._logService.debug('[ParadisAgentBrowserOpenedTabs] could not unshare an opened tab', error);
			}
		}
	}

	private async _call<T>(method: string, args: unknown[]): Promise<T | undefined> {
		try {
			return await this._sharedProcessService.getChannel(PARADIS_AGENT_BROWSER_CHANNEL).call<T>(method, args);
		} catch {
			return undefined;
		}
	}
}

registerWorkbenchContribution2(ParadisAgentBrowserOpenedTabsContribution.ID, ParadisAgentBrowserOpenedTabsContribution, WorkbenchPhase.AfterRestored);
