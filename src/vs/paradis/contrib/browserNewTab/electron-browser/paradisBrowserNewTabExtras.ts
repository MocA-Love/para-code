/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの新しいタブのうち、サーバーの一覧以外の部品（Orca の新しいタブに合わせたもの）。
//
//  - このスペースの PR の行: スマホの PR の画面と同じ `getPullRequestDetail`（そのスペースの作業ツリーがある
//    マシンの git channel で `gh pr view`）を使う。GitHub の制限に触れないよう、新しいタブが見えたときだけ
//    取りに行き、スペースごとに 5 分覚える（見出しの更新ボタンでも 30 秒より新しければ取り直さない）
//  - ほかのブラウザのログインの取り込みの案内: macOS で、取り込める Chromium 系のブラウザが見つかったときだけ。
//    「この案内を出さない」を押すと、このアプリでは二度と出さない
//  - よく開くページとブックマークのタイル

import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IParadisBookmarksService } from '../../browserBookmarks/electron-browser/paradisBookmarksService.js';
import { IParadisBrowserLoginImportMainService, PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL } from '../../browserProfiles/common/paradisBrowserLoginImport.js';
import { PARADIS_BROWSER_IMPORT_LOGINS_COMMAND_ID } from '../../browserSettings/common/paradisBrowserSettings.js';
import { IParadisPullRequestDetail, ParadisPullRequestLookup, paradisPullRequestCheckCounts } from '../../mobileRelay/common/paradisMobilePullRequest.js';
import { PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID } from '../../paradisSettings/electron-browser/paradisSettingsDialog.contribution.js';
import { PARADIS_WORKTREE_GIT_CHANNEL } from '../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { paradisChannelHostResolver } from '../../workspaceSwitch/electron-browser/paradisWorktreeGitChannelClient.js';
import { paradisTrimPullRequestCache } from '../common/paradisBrowserNewTab.js';
import { IParadisNewTabTile } from '../common/paradisBrowserNewTabTiles.js';

const $ = dom.$;

const PULL_REQUEST_CACHE_MS = 5 * 60_000;
const PULL_REQUEST_MIN_REFRESH_MS = 30_000;
/** 覚えておく PR の数の上限（スペースを多く渡り歩いても増え続けないように、古いものから捨てる）。 */
const PULL_REQUEST_CACHE_LIMIT = 32;
const IMPORT_HINT_HIDDEN_KEY = 'paradis.browserNewTab.importHintHidden';

/** スペース（作業ツリーのルート）ごとの PR。窓の中の全部の新しいタブで共有する。 */
const pullRequests = new Map<string, { at: number; lookup: ParadisPullRequestLookup | undefined; pending: boolean }>();

/** 取り込めるブラウザの名前（窓ごとに 1 回だけ数える）。 */
let importableBrowsers: Promise<readonly string[]> | undefined;

/** 部品が開く URL。⌘ / Ctrl・中クリックなら新しいタブ。 */
export type ParadisNewTabOpen = (url: string, inNewTab: boolean) => void;

export class ParadisBrowserNewTabExtras extends Disposable {

	private _importBrowsers: readonly string[] = [];

	constructor(
		private readonly _onDidChange: () => void,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
		@IStorageService private readonly _storageService: IStorageService,
		@ICommandService private readonly _commandService: ICommandService,
		@IParadisBookmarksService private readonly _bookmarksService: IParadisBookmarksService,
	) {
		super();
		this._register(this._bookmarksService.onDidChange(() => this._onDidChange()));
		void this._loadImportBrowsers();
	}

	get bookmarks(): IParadisBookmarksService {
		return this._bookmarksService;
	}

	// #region 取り込みの案内

	private _importHintHidden(): boolean {
		return this._storageService.getBoolean(IMPORT_HINT_HIDDEN_KEY, StorageScope.APPLICATION, false);
	}

	private async _loadImportBrowsers(): Promise<void> {
		if (!isMacintosh || this._importHintHidden()) {
			return;
		}
		importableBrowsers ??= (async () => {
			try {
				const service = ProxyChannel.toService<IParadisBrowserLoginImportMainService>(this._mainProcessService.getChannel(PARADIS_BROWSER_LOGIN_IMPORT_CHANNEL));
				const listing = await service.listSources();
				return listing.browsers.filter(browser => browser.profiles.length > 0 && !browser.unsupportedReason).map(browser => browser.label);
			} catch {
				return [];
			}
		})();
		const names = await importableBrowsers;
		if (!this._store.isDisposed && names.length > 0) {
			this._importBrowsers = names;
			this._onDidChange();
		}
	}

	renderImportCard(parent: HTMLElement, store: DisposableStore): void {
		if (this._importBrowsers.length === 0 || this._importHintHidden()) {
			return;
		}
		const card = dom.append(parent, $('.pbnt-import'));
		card.appendChild($(`span.pbnt-import-icon${ThemeIcon.asCSSSelector(Codicon.signIn)}`));
		const main = dom.append(card, $('.pbnt-import-main'));
		// allow-any-unicode-next-line
		dom.append(main, $('.pbnt-import-title')).textContent = localize('paradis.browserNewTab.importTitle', "ほかのブラウザのログインを取り込めます");
		// allow-any-unicode-next-line
		dom.append(main, $('.pbnt-import-detail')).textContent = localize('paradis.browserNewTab.importDetail', "{0} を見つけました。サイトを選んで、名前付きのプロファイルへ取り込みます。", this._importBrowsers.join('・'));
		// allow-any-unicode-next-line
		const run = this._button(card, localize('paradis.browserNewTab.importRun', "取り込む…"), true);
		store.add(dom.addDisposableListener(run, dom.EventType.CLICK, () => void this._commandService.executeCommand(PARADIS_BROWSER_IMPORT_LOGINS_COMMAND_ID)));
		// allow-any-unicode-next-line
		const settings = this._button(card, localize('paradis.browserNewTab.importSettings', "ブラウザの設定"), false);
		store.add(dom.addDisposableListener(settings, dom.EventType.CLICK, () => void this._commandService.executeCommand(PARADIS_OPEN_SETTINGS_DIALOG_COMMAND_ID, 'psd-sec-browser')));
		const hide = dom.append(card, $('button.pbnt-icon-button')) as HTMLButtonElement;
		hide.type = 'button';
		// allow-any-unicode-next-line
		hide.title = localize('paradis.browserNewTab.importHide', "この案内を出さない");
		hide.setAttribute('aria-label', hide.title);
		hide.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.close)}`));
		store.add(dom.addDisposableListener(hide, dom.EventType.CLICK, () => {
			this._storageService.store(IMPORT_HINT_HIDDEN_KEY, true, StorageScope.APPLICATION, StorageTarget.USER);
			this._importBrowsers = [];
			this._onDidChange();
		}));
	}

	private _button(parent: HTMLElement, label: string, primary: boolean): HTMLButtonElement {
		const button = dom.append(parent, $(`button.pbnt-button${primary ? '' : '.secondary'}`)) as HTMLButtonElement;
		button.type = 'button';
		button.textContent = label;
		return button;
	}

	// #endregion

	// #region このスペースの PR

	/** 覚えている PR。古ければ取りに行き、届いたら描き直す。 */
	pullRequest(root: URI | undefined, force: boolean): IParadisPullRequestDetail | undefined {
		if (!root) {
			return undefined;
		}
		const key = root.toString();
		const cached = pullRequests.get(key);
		const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
		if (!cached?.pending && (age > PULL_REQUEST_CACHE_MS || (force && age > PULL_REQUEST_MIN_REFRESH_MS))) {
			void this._fetchPullRequest(key, root, cached?.lookup);
		}
		const lookup = pullRequests.get(key)?.lookup;
		return lookup?.kind === 'ok' ? lookup.detail : undefined;
	}

	private async _fetchPullRequest(key: string, root: URI, previous: ParadisPullRequestLookup | undefined): Promise<void> {
		pullRequests.set(key, { at: Date.now(), lookup: previous, pending: true });
		let lookup: ParadisPullRequestLookup | undefined = previous;
		try {
			const host = this._instantiationService.invokeFunction(accessor => paradisChannelHostResolver(accessor, PARADIS_WORKTREE_GIT_CHANNEL, 'reject')(root));
			if (host) {
				lookup = await host.channel.call<ParadisPullRequestLookup>('getPullRequestDetail', [host.path(root)]);
			}
		} catch {
			// gh が無い・古い接続先・つながらない。前の結果のまま（無ければ出さない）
		}
		pullRequests.set(key, { at: Date.now(), lookup, pending: false });
		paradisTrimPullRequestCache(pullRequests, PULL_REQUEST_CACHE_LIMIT);
		if (!this._store.isDisposed) {
			this._onDidChange();
		}
	}

	renderPullRequestRow(list: HTMLElement, detail: IParadisPullRequestDetail, open: ParadisNewTabOpen, store: DisposableStore): void {
		const row = dom.append(list, $('button.pbnt-row')) as HTMLButtonElement;
		row.type = 'button';
		row.title = detail.url;
		const icon = dom.append(row, $('span.pbnt-icon'));
		icon.appendChild($(`span${ThemeIcon.asCSSSelector(detail.state === 'merged' ? Codicon.gitMerge : Codicon.gitPullRequest)}`));
		const main = dom.append(row, $('span.pbnt-main'));
		dom.append(main, $('span.pbnt-title')).textContent = detail.title;
		const parts = [`#${detail.number}`, stateLabel(detail)];
		const checks = checksLabel(detail);
		if (checks) {
			parts.push(checks);
		}
		dom.append(main, $('span.pbnt-detail')).textContent = parts.join(' · ');
		const go = dom.append(row, $('span.pbnt-go'));
		go.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.arrowRight)}`));
		this._bindOpen(row, detail.url, open, store);
	}

	// #endregion

	// #region タイル

	renderTiles(parent: HTMLElement, caption: string, tiles: readonly IParadisNewTabTile[], iconOf: (key: string | undefined) => string | undefined, open: ParadisNewTabOpen, store: DisposableStore): void {
		if (tiles.length === 0) {
			return;
		}
		const section = dom.append(parent, $('section.pbnt-section'));
		const head = dom.append(section, $('.pbnt-caption'));
		dom.append(head, $('span.pbnt-caption-name')).textContent = caption;
		const grid = dom.append(section, $('.pbnt-tiles'));
		for (const tile of tiles) {
			const button = dom.append(grid, $('button.pbnt-tile')) as HTMLButtonElement;
			button.type = 'button';
			button.title = `${tile.title}\n${tile.url}`;
			const icon = dom.append(button, $('span.pbnt-tile-icon'));
			const favicon = iconOf(tile.iconKey);
			if (favicon) {
				const image = dom.append(icon, $('img')) as HTMLImageElement;
				image.alt = '';
				image.src = favicon;
			} else {
				icon.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.globe)}`));
			}
			dom.append(button, $('span.pbnt-tile-label')).textContent = tile.title;
			this._bindOpen(button, tile.url, open, store);
		}
	}

	// #endregion

	private _bindOpen(element: HTMLElement, url: string, open: ParadisNewTabOpen, store: DisposableStore): void {
		store.add(dom.addDisposableListener(element, dom.EventType.CLICK, event => open(url, event.metaKey || event.ctrlKey)));
		store.add(dom.addDisposableListener(element, dom.EventType.AUXCLICK, event => {
			if (event.button === 1) {
				event.preventDefault();
				open(url, true);
			}
		}));
	}
}

function stateLabel(detail: IParadisPullRequestDetail): string {
	switch (detail.state) {
		// allow-any-unicode-next-line
		case 'draft': return localize('paradis.browserNewTab.prDraft', "下書き");
		// allow-any-unicode-next-line
		case 'merged': return localize('paradis.browserNewTab.prMerged', "マージ済み");
		// allow-any-unicode-next-line
		case 'closed': return localize('paradis.browserNewTab.prClosed', "閉じた");
		// allow-any-unicode-next-line
		default: return localize('paradis.browserNewTab.prOpen', "オープン");
	}
}

function checksLabel(detail: IParadisPullRequestDetail): string | undefined {
	const counts = detail.checkCounts ?? paradisPullRequestCheckCounts(detail.checks);
	if (counts.fail + counts.cancel > 0) {
		// allow-any-unicode-next-line
		return localize('paradis.browserNewTab.prChecksFailing', "チェック失敗 {0} 件", counts.fail + counts.cancel);
	}
	if (counts.pending > 0) {
		// allow-any-unicode-next-line
		return localize('paradis.browserNewTab.prChecksPending', "チェック待ち {0} 件", counts.pending);
	}
	if (counts.pass > 0) {
		// allow-any-unicode-next-line
		return localize('paradis.browserNewTab.prChecksPassing', "チェック成功");
	}
	return undefined;
}
