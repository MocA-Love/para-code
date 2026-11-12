/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザの新しいタブ（URL が空のタブ）に、このスペースで動いている開発サーバーの一覧を出す。
//
// 本家の案内（browserWelcomeFeature.ts、地球儀と 1 行の案内）と同じ「中身の場所」（ContentArea）の部品で、
// 本家の案内より後ろ（上）に重ねる。ページ（WebContentsView）の中ではなく Para Code の DOM なので、
// ページの JavaScript からは見えず、ネイティブのビューの裏にも隠れない。本家のファイルは変えていない。
//
// ⌘T とタブの行の地球儀は新しいタブを開くと同時に URL を選ぶ一覧（Quick Input）を開くので、その一覧にも
// 「このスペースのサーバー」を候補として出す（開いた直後から選べるように）。
//
// SSH の窓では、ポート一覧が接続先のポートを読む。開く URL は、タブの通信が接続先を通るとき
// （workbench.browser.enableRemoteProxy がオンで、名前付きのプロファイルでないタブ）だけ localhost のまま、
// それ以外は本家のポート転送で手元のアドレスに変えてから開く（名前付きのプロファイルのタブでも届くように）。

import './media/paradisBrowserNewTab.css';
import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { BrowserViewUri } from '../../../../platform/browserView/common/browserViewUri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget, IBrowserUrlSuggestion, IBrowserUrlSuggestionContext, IBrowserUrlSuggestionProvider } from '../../../../workbench/contrib/browserView/electron-browser/browserEditor.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisBrowserProfilesService } from '../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import { IParadisPortPageInfo } from '../../portList/common/paradisPortList.js';
import { ParadisPortListClient } from '../../portList/electron-browser/paradisPortListClient.js';
import { IParadisBrowserScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService, paradisListSpaces, paradisResolveSpaceInfo, paradisScopeRootPath, paradisSpaceInfoLabel } from '../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisNewTabServer, IParadisNewTabServerGroups, IParadisNewTabSpace, paradisGroupNewTabServers, paradisNewTabServerAddress } from '../common/paradisBrowserNewTab.js';
import { paradisBookmarkTiles, paradisRankFrequentPages } from '../common/paradisBrowserNewTabTiles.js';
import { ParadisBrowserNewTabExtras } from './paradisBrowserNewTabExtras.js';

const $ = dom.$;

/** 本家の案内（order 50）より後ろに置いて、上に重ねる。 */
const WIDGET_ORDER = 60;
/** 見えている間に一覧を取り直す間隔。 */
const REFRESH_INTERVAL_MS = 10_000;

// allow-any-unicode-next-line
const STR_THIS_SPACE = localize('paradis.browserNewTab.thisSpace', "このスペース");
// allow-any-unicode-next-line
const STR_THIS_WINDOW = localize('paradis.browserNewTab.thisWindow', "このウィンドウ");
// allow-any-unicode-next-line
const STR_REFRESH = localize('paradis.browserNewTab.refresh', "一覧を取り直す");
// allow-any-unicode-next-line
const STR_NONE = localize('paradis.browserNewTab.none', "このスペースのフォルダで動いているサーバーはありません。");
// allow-any-unicode-next-line
const STR_OUTSIDE = localize('paradis.browserNewTab.outside', "Para Code の外");
// allow-any-unicode-next-line
const STR_SUGGESTION_GROUP = localize('paradis.browserNewTab.suggestionGroup', "このスペースのサーバー");
// allow-any-unicode-next-line
const STR_FREQUENT = localize('paradis.browserNewTab.frequent', "よく開くページ");
// allow-any-unicode-next-line
const STR_BOOKMARKS = localize('paradis.browserNewTab.bookmarks', "ブックマーク");
// allow-any-unicode-next-line
const STR_ROW_HOVER = localize('paradis.browserNewTab.rowHover', "このタブで開く（⌘ / Ctrl を押しながらで新しいタブ）");

interface IServerView {
	readonly server: IParadisNewTabServer;
	readonly page: IParadisPortPageInfo | undefined;
}

/** 新しいタブの一覧の部品。1 つのブラウザのエディタに 1 つ。 */
export class ParadisBrowserNewTabFeature extends BrowserEditorContribution {

	private readonly _container: HTMLElement;
	private readonly _widget: IBrowserEditorWidget;
	private readonly _client: ParadisPortListClient;
	private readonly _render = this._register(new MutableDisposable<DisposableStore>());
	private readonly _onDidChangeSuggestions = this._register(new Emitter<void>());

	private _groups: IParadisNewTabServerGroups | undefined;
	private _currentLabel = '';
	private _currentRoot: URI | undefined;
	private _forcePullRequest = false;
	private readonly _extras: ParadisBrowserNewTabExtras;
	private readonly _pages = new Map<number, IParadisPortPageInfo>();
	private _othersOpen = false;
	private _loading = false;
	/** 読み込み中に「一覧を取り直す」が押された。終わったらもう一度 force で取る。 */
	private _forceAfterLoad = false;
	/** 今の描画で印を付けた部品（印 → 部品）。描き直した後にフォーカスを戻す先を引く。 */
	private readonly _focusTargets = new Map<string, HTMLElement>();
	private _visible = false;
	private _generation = 0;

	private readonly _suggestionProvider: IBrowserUrlSuggestionProvider = {
		label: STR_SUGGESTION_GROUP,
		order: 3,
		onDidChange: this._onDidChangeSuggestions.event,
		getSuggestions: (context, token) => this._getSuggestions(context, token),
	};

	constructor(
		editor: BrowserEditor,
		@IInstantiationService instantiationService: IInstantiationService,
		@IParadisWorkspaceSwitchService private readonly _workspaceSwitchService: IParadisWorkspaceSwitchService,
		@IParadisWorktreeService private readonly _worktreeService: IParadisWorktreeService,
		@IParadisBrowserScopeService private readonly _browserScopeService: IParadisBrowserScopeService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IRemoteAgentService private readonly _remoteAgentService: IRemoteAgentService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IBrowserViewWorkbenchService private readonly _browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IParadisBrowserProfilesService private readonly _profilesService: IParadisBrowserProfilesService,
		@IEditorService private readonly _editorService: IEditorService,
	) {
		super(editor);
		this._client = instantiationService.createInstance(ParadisPortListClient);
		this._extras = this._register(instantiationService.createInstance(ParadisBrowserNewTabExtras, () => this._renderPage(), (element, key) => this._markFocus(element, key)));
		this._container = $('.paradis-browser-new-tab');
		this._container.style.display = 'none';
		this._widget = { location: BrowserWidgetLocation.ContentArea, element: this._container, order: WIDGET_ORDER };

		const handle = dom.getWindow(this._container).setInterval(() => {
			if (this._visible && this._container.isConnected && dom.getWindow(this._container).document.hasFocus()) {
				void this._load(false);
			}
		}, REFRESH_INTERVAL_MS);
		this._register(toDisposable(() => dom.getWindow(this._container).clearInterval(handle)));
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [this._widget];
	}

	override get urlSuggestionProviders(): readonly IBrowserUrlSuggestionProvider[] {
		return [this._suggestionProvider];
	}

	override prerenderInput(input: BrowserEditorInput): void {
		this._setVisible(!input.url);
	}

	protected override onModelAttached(model: IBrowserViewModel, store: DisposableStore): void {
		this._setVisible(!model.url);
		store.add(model.onDidNavigate(event => this._setVisible(!event.url)));
	}

	override onModelDetached(): void {
		this._setVisible(false);
	}

	private _setVisible(visible: boolean): void {
		const wasVisible = this._visible;
		this._visible = visible;
		if (!visible) {
			this._container.style.display = 'none';
			return;
		}
		// 一覧が届くまでは本家の案内を見せておく（届いたら上に重ねる）
		if (this._groups) {
			this._renderPage();
		}
		if (!wasVisible) {
			void this._load(false);
		}
	}

	// #region 一覧を集める

	/** スペースの一覧と、このタブのスペース。スペースを管理しない窓では、ワークスペースのフォルダを 1 つのスペースとして扱う。 */
	private _spaces(): { spaces: IParadisNewTabSpace[]; currentKey: string | undefined; currentLabel: string; currentRoot: URI | undefined } {
		const authority = this._remoteAgentService.getConnection()?.remoteAuthority;
		if (this._workspaceSwitchService.isManagedWorkspaceWindow) {
			const repositories = this._workspaceSwitchService.repositories;
			const cache = new Map();
			const spaces: IParadisNewTabSpace[] = [];
			const roots = new Map<string, URI>();
			for (const entry of paradisListSpaces(repositories, this._worktreeService)) {
				roots.set(entry.space, entry.uri);
				const rootPath = paradisScopeRootPath(entry.uri, authority);
				if (rootPath === undefined) {
					continue;
				}
				spaces.push({ key: entry.space, label: paradisSpaceInfoLabel(paradisResolveSpaceInfo(entry.space, repositories, this._worktreeService, cache)) || entry.name, rootPath });
			}
			const model = this.editor.model;
			const scope = model ? this._browserScopeService.resolveScope(model.id) : undefined;
			const currentKey = scope?.kind === 'managed' ? scope.stateKey : this._workspaceSwitchService.activeStateKey;
			return { spaces, currentKey, currentLabel: spaces.find(space => space.key === currentKey)?.label ?? '', currentRoot: currentKey !== undefined ? roots.get(currentKey) : undefined };
		}
		const spaces: IParadisNewTabSpace[] = [];
		for (const folder of this._workspaceContextService.getWorkspace().folders) {
			const rootPath = paradisScopeRootPath(folder.uri, authority);
			if (rootPath !== undefined) {
				spaces.push({ key: 'window', label: folder.name, rootPath });
			}
		}
		return { spaces, currentKey: spaces.length ? 'window' : undefined, currentLabel: spaces.length === 1 ? spaces[0].label : STR_THIS_WINDOW, currentRoot: this._workspaceContextService.getWorkspace().folders[0]?.uri };
	}

	private async _load(force: boolean): Promise<void> {
		if (this._loading) {
			if (force) {
				this._forceAfterLoad = true;
			}
			return;
		}
		this._loading = true;
		const generation = ++this._generation;
		try {
			const { spaces, currentKey, currentLabel, currentRoot } = this._spaces();
			this._currentLabel = currentLabel;
			this._currentRoot = currentRoot;
			this._forcePullRequest = force;
			const snapshot = await this._client.getServers(force);
			// 手元が Windows でも、SSH の接続先（Linux）のパスは大文字と小文字を区別する
			const caseInsensitive = isWindows && !this._remoteAgentService.getConnection();
			const groups = paradisGroupNewTabServers(snapshot.entries, spaces, currentKey, snapshot.homeDir, caseInsensitive);
			if (generation !== this._generation || this._store.isDisposed) {
				return;
			}
			this._groups = groups;
			this._renderPage();
			this._onDidChangeSuggestions.fire();

			// 題とアイコンは、このスペース → ほかのスペースの順に上限まで読む（Para Code の外のものは読まない）
			const targets = [...groups.current, ...groups.otherSpaces].filter(server => !this._pages.has(server.port));
			if (targets.length > 0) {
				const pages = await this._client.probePages(targets.map(server => ({ port: server.port, address: server.address, pid: server.pid })));
				if (generation !== this._generation || this._store.isDisposed) {
					return;
				}
				for (const page of pages) {
					this._pages.set(page.port, page);
				}
				this._renderPage();
				this._onDidChangeSuggestions.fire();
			}
			// 終わったサーバーの題は捨てる（同じ番号で別のサーバーが立つことがある）
			const alive = new Set([...groups.current, ...groups.otherSpaces].map(server => server.port));
			for (const port of [...this._pages.keys()]) {
				if (!alive.has(port)) {
					this._pages.delete(port);
				}
			}
		} catch {
			// 古い接続先（このチャネルの口が無い）や、ポートを読めない環境。サーバーの一覧は空のまま、ほかの部品は出す
			if (generation === this._generation && !this._store.isDisposed && !this._groups) {
				this._groups = { current: [], otherSpaces: [], outside: [] };
				this._renderPage();
			}
		} finally {
			this._loading = false;
		}
		if (this._forceAfterLoad && !this._store.isDisposed) {
			this._forceAfterLoad = false;
			void this._load(true);
		}
	}

	// #endregion

	// #region 開く

	private _pageOf(server: IParadisNewTabServer): IParadisPortPageInfo | undefined {
		return this._pages.get(server.port);
	}

	private _titleOf(view: IServerView): string {
		return view.page?.title || view.server.processName || paradisNewTabServerAddress(view.server.port);
	}

	/**
	 * 開く URL。SSH の窓で、このタブの通信が接続先を通らないとき（既定・名前付きのプロファイル）は、
	 * 本家のポート転送で手元のアドレスに変える。
	 */
	private async _resolveUrl(server: IParadisNewTabServer, viewId: string | undefined): Promise<string> {
		const scheme = this._pageOf(server)?.scheme ?? 'http';
		const url = `${scheme}://localhost:${server.port}/`;
		if (!this._remoteAgentService.getConnection()) {
			return url;
		}
		// viewId が分からない（これから開く新しいタブ）ときは、スペースの既定が名前付きのプロファイルでも届くよう転送する
		const viaRemote = this._browserViewWorkbenchService.resolveNetwork({ type: 'user' }) !== undefined;
		const named = viewId === undefined || this._profilesService.getViewSession(viewId)?.profileId !== undefined;
		if (viaRemote && !named) {
			return url;
		}
		try {
			const resolved = await this._openerService.resolveExternalUri(URI.parse(url), { allowTunneling: true });
			return resolved.resolved.toString(true);
		} catch {
			return url;
		}
	}

	private async _open(server: IParadisNewTabServer, inNewTab: boolean): Promise<void> {
		const input = this.editor.input;
		if (inNewTab || !(input instanceof BrowserEditorInput)) {
			// 新しいタブはスペースの既定のプロファイルで開くので、どのプロファイルか分からない。転送したアドレスにしておく
			const url = await this._resolveUrl(server, undefined);
			await this._editorService.openEditor({ resource: BrowserViewUri.forId(generateUuid()), options: { pinned: true, inactive: true, viewState: { url } } }, await this._browserViewWorkbenchService.getPreferredGroup());
			return;
		}
		const url = await this._resolveUrl(server, this.editor.model?.id);
		if (!input.isDisposed()) {
			input.navigate(url);
		}
	}

	/** PR・タイルの URL を開く。⌘ / Ctrl・中クリックなら裏の新しいタブ。 */
	private _openUrl(url: string, inNewTab: boolean): void {
		const input = this.editor.input;
		if (inNewTab || !(input instanceof BrowserEditorInput)) {
			void (async () => this._editorService.openEditor({ resource: BrowserViewUri.forId(generateUuid()), options: { pinned: true, inactive: true, viewState: { url } } }, await this._browserViewWorkbenchService.getPreferredGroup()))();
			return;
		}
		if (!input.isDisposed()) {
			input.navigate(url);
		}
	}

	private async _getSuggestions(context: IBrowserUrlSuggestionContext, token: CancellationToken): Promise<readonly IBrowserUrlSuggestion[]> {
		if (!this._groups) {
			await this._load(false);
		}
		const groups = this._groups;
		if (!groups || token.isCancellationRequested) {
			return [];
		}
		const text = context.text.trim().toLowerCase();
		const suggestions: IBrowserUrlSuggestion[] = [];
		for (const server of groups.current) {
			const view = { server, page: this._pageOf(server) };
			const title = this._titleOf(view);
			const address = paradisNewTabServerAddress(server.port);
			// 打った文字（Ctrl+L で開いたときは今の URL）が当たるものだけ出す。空なら全部
			if (text && !`${title} ${address}`.toLowerCase().includes(text)) {
				continue;
			}
			suggestions.push({
				id: `paradis.browserNewTab.server.${server.port}`,
				label: title,
				description: `${address} · ${server.processName}`,
				icon: Codicon.server,
				apply: async input => {
					const url = await this._resolveUrl(server, input.model?.id);
					if (!input.isDisposed()) {
						input.navigate(url);
					}
				},
			});
		}
		return suggestions;
	}

	// #endregion

	// #region 描く

	private _renderPage(): void {
		const groups = this._groups;
		if (!this._visible || !groups) {
			return;
		}
		// 作り直すとフォーカスのあった行が消えるので、印（data-pbnt-focus）を覚えて描いた後に戻す
		const focused = dom.getActiveElement();
		const focusKey = dom.isHTMLElement(focused) && this._container.contains(focused) ? focused.dataset.pbntFocus : undefined;
		const store = new DisposableStore();
		this._render.value = store;
		dom.clearNode(this._container);
		this._container.style.display = '';
		this._focusTargets.clear();
		this._fillPage(groups, store);
		if (focusKey !== undefined) {
			this._focusTargets.get(focusKey)?.focus();
		}
	}

	private _markFocus(element: HTMLElement, key: string): void {
		element.dataset.pbntFocus = key;
		this._focusTargets.set(key, element);
	}

	private _fillPage(groups: IParadisNewTabServerGroups, store: DisposableStore): void {

		const column = dom.append(this._container, $('.pbnt-column'));
		const open = (url: string, inNewTab: boolean) => this._openUrl(url, inNewTab);
		this._extras.renderImportCard(column, store);
		const section = dom.append(column, $('section.pbnt-section'));
		const caption = dom.append(section, $('.pbnt-caption'));
		dom.append(caption, $('span.pbnt-caption-name')).textContent = STR_THIS_SPACE;
		if (this._currentLabel) {
			dom.append(caption, $('span.pbnt-caption-sep')).textContent = '·';
			dom.append(caption, $('span.pbnt-caption-detail')).textContent = this._currentLabel;
		}
		const refresh = dom.append(caption, $('button.pbnt-icon-button')) as HTMLButtonElement;
		refresh.type = 'button';
		this._markFocus(refresh, 'refresh');
		refresh.title = STR_REFRESH;
		refresh.setAttribute('aria-label', STR_REFRESH);
		refresh.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.refresh)}`));
		store.add(dom.addDisposableListener(refresh, dom.EventType.CLICK, () => void this._load(true)));

		const pullRequest = this._extras.pullRequest(this._currentRoot, this._forcePullRequest);
		this._forcePullRequest = false;
		if (groups.current.length > 0 || pullRequest) {
			const list = dom.append(section, $('.pbnt-list'));
			for (const server of groups.current) {
				this._renderRow(list, { server, page: this._pageOf(server) }, server.processName, store);
			}
			if (groups.current.length === 0) {
				dom.append(list, $('.pbnt-empty')).textContent = STR_NONE;
			}
			if (pullRequest) {
				dom.append(list, $('.pbnt-divider'));
				this._extras.renderPullRequestRow(list, pullRequest, open, store);
			}
		} else {
			dom.append(section, $('.pbnt-empty')).textContent = STR_NONE;
		}

		const others = [...groups.otherSpaces, ...groups.outside];
		if (others.length > 0) {
			const toggle = dom.append(section, $('button.pbnt-more')) as HTMLButtonElement;
			toggle.type = 'button';
			this._markFocus(toggle, 'others');
			toggle.setAttribute('aria-expanded', String(this._othersOpen));
			toggle.appendChild($(`span${ThemeIcon.asCSSSelector(this._othersOpen ? Codicon.chevronDown : Codicon.chevronRight)}`));
			dom.append(toggle, $('span')).textContent = groups.otherSpaces.length > 0
				// allow-any-unicode-next-line
				? localize('paradis.browserNewTab.othersWithSpaces', "ほかのスペースで {0} 件・Para Code の外で {1} 件", groups.otherSpaces.length, groups.outside.length)
				// allow-any-unicode-next-line
				: localize('paradis.browserNewTab.othersOutside', "Para Code の外で {0} 件", groups.outside.length);
			store.add(dom.addDisposableListener(toggle, dom.EventType.CLICK, () => {
				this._othersOpen = !this._othersOpen;
				this._renderPage();
			}));
			if (this._othersOpen) {
				const list = dom.append(section, $('.pbnt-list.pbnt-list-others'));
				for (const server of groups.otherSpaces) {
					this._renderRow(list, { server, page: this._pageOf(server) }, server.space?.label ?? '', store);
				}
				for (const server of groups.outside) {
					this._renderRow(list, { server, page: undefined }, STR_OUTSIDE, store);
				}
			}
		}
		this._renderTiles(column, open, store);
	}

	private _renderTiles(column: HTMLElement, open: (url: string, inNewTab: boolean) => void, store: DisposableStore): void {
		const history = this.editor.model?.history;
		if (history) {
			this._extras.renderTiles(column, STR_FREQUENT, paradisRankFrequentPages(history.entries.items), key => key ? history.favicons.get(key) : undefined, open, store);
		}
		const bookmarks = this._extras.bookmarks;
		this._extras.renderTiles(column, STR_BOOKMARKS, paradisBookmarkTiles(bookmarks.nodes), key => bookmarks.getFavicon(key), open, store);
	}

	private _renderRow(list: HTMLElement, view: IServerView, context: string, store: DisposableStore): void {
		const row = dom.append(list, $('button.pbnt-row')) as HTMLButtonElement;
		row.type = 'button';
		this._markFocus(row, `server:${view.server.port}`);
		row.title = STR_ROW_HOVER;
		const icon = dom.append(row, $('span.pbnt-icon'));
		if (view.page?.faviconDataUrl) {
			const image = dom.append(icon, $('img')) as HTMLImageElement;
			image.alt = '';
			image.src = view.page.faviconDataUrl;
		} else {
			icon.appendChild($(`span${ThemeIcon.asCSSSelector(view.page?.isPage ? Codicon.globe : Codicon.server)}`));
		}
		const main = dom.append(row, $('span.pbnt-main'));
		dom.append(main, $('span.pbnt-title')).textContent = this._titleOf(view);
		const detail = dom.append(main, $('span.pbnt-detail'));
		dom.append(detail, $('span.pbnt-dot'));
		dom.append(detail, $('span.pbnt-address')).textContent = paradisNewTabServerAddress(view.server.port);
		if (context) {
			dom.append(detail, $('span')).textContent = ` · ${context}`;
		}
		const go = dom.append(row, $('span.pbnt-go'));
		go.appendChild($(`span${ThemeIcon.asCSSSelector(Codicon.arrowRight)}`));
		store.add(dom.addDisposableListener(row, dom.EventType.CLICK, event => {
			void this._open(view.server, event.metaKey || event.ctrlKey);
		}));
		store.add(dom.addDisposableListener(row, dom.EventType.AUXCLICK, event => {
			if (event.button === 1) {
				event.preventDefault();
				void this._open(view.server, true);
			}
		}));
	}

	// #endregion
}

BrowserEditor.registerContribution(ParadisBrowserNewTabFeature);
