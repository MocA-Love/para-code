/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/browser-extension-tab-model.ts, src/main/browser/extensions/api/tabs.ts, src/main/browser/extensions/api/windows.ts, src/main/browser/extensions/api/web-navigation.ts, src/main/browser/extensions/browser-extension-document-ids.ts, src/main/browser/extensions/api/runtime.ts

// chrome.tabs・chrome.windows・chrome.webNavigation と runtime.openOptionsPage（詰め物の名前空間）。
//
// 拡張機能に見せるタブ: 呼び出し元と同じセッション（Electron の Session）の、内蔵ブラウザのタブだけ。
//  - 別の場所（名前付きプロファイル、ほかのワークスペース、SSH 先のページのためにトンネルを通すセッション）の
//    タブは別のセッションなので見えない
//  - エージェントのタブ（エージェントの持ち物のビューと、エージェントが自分で開いたタブとそこから開いたタブ）
//    は、同じセッションにあっても見せない（イベントも出さない）
//  - 拡張機能が windows.create で開いた、拡張機能自身のページだけを出す窓（ポップアップ）も、その窓の 1 つの
//    タブとして見せる
// タブの id は WebContents の id（Electron の tabs.sendMessage・scripting と同じ番号）。窓の id は
// Para Code のウィンドウ（BrowserWindow）の id。
//
// まだ開いていない（復元しただけで読み込んでいない）タブは見せない（Orca の「破棄済みのタブ」は未対応）。

import { randomBytes } from 'crypto';
import type { BrowserWindow, Session, WebContents, WebFrameMain } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { ICDPConnection } from '../../../../platform/browserView/common/cdp/types.js';
import { paradisIsExtensionPageHeld } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { paradisIsChromeWebStoreUrl } from '../common/paradisBrowserExtensionWebStore.js';
import { paraOnDidMarkBrowserViewAgentTab } from '../../../../platform/browserView/electron-main/paraBrowserViewLoadWatchdog.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import { IParadisTabGroupChanges, PARADIS_TAB_GROUP_COLORS, ParadisTabGroupLedger } from './paradisBrowserExtensionTabGroups.js';

/** 内蔵ブラウザのタブ 1 つ（main の BrowserView の、ここで使うところ）。 */
export interface IParadisTabView {
	readonly id: string;
	readonly webContents: WebContents;
	/** タブがある Para Code のウィンドウ。 */
	readonly windowId: number;
	/** エージェントのタブか（持ち主がエージェント、またはエージェントが開いたタブとその子）。 */
	isAgentTab(): boolean;
	/** エディタで表示されているか（グループの中で選ばれているタブ）。 */
	isVisible(): boolean;
	readonly onDidClose: Event<void>;
	readonly onDidChangeVisibility: Event<boolean>;
}

/** タブとウィンドウを扱うための、main のサービスの口（プロファイルの main から渡す）。 */
export interface IParadisTabEnvironment {
	listViews(): readonly IParadisTabView[];
	/** タブができた（`existing`: 拡張機能の管理より前からあったタブを、見つけたときに知らせるもの）。 */
	readonly onDidCreateView: Event<{ readonly view: IParadisTabView; readonly existing: boolean }>;
	/** Para Code のウィンドウ（補助ウィンドウを含む）。 */
	listWindows(): readonly BrowserWindow[];
	/** 最後に使った Para Code のウィンドウ。 */
	lastActiveWindowId(): number | undefined;
	/** そのセッションでタブを開く（`browserSessionId` は BrowserSession の id）。 */
	createTab(url: string, browserSessionId: string, windowId: number, background: boolean): Promise<IParadisTabView>;
	closeTab(viewId: string): Promise<void>;
	/** タブをエディタで前に出す（そのウィンドウの workbench が行う）。 */
	activateTab(windowId: number, viewId: string): void;
	/** Para Code のウィンドウにフォーカスが移った（ウィンドウの id）。 */
	readonly onDidFocusWindow: Event<number>;
	/** タブのページへの CDP セッションを開く（chrome.debugger。無ければ chrome.debugger は使えない）。 */
	attachDebugger?(viewId: string): Promise<ICDPConnection>;
}

/** 拡張機能を読み込んだセッション（タブの API に要るところ）。 */
export interface IParadisTabSession {
	readonly session: ParadisApiSession & { readonly extensions: { getAllExtensions(): readonly IParadisApiExtension[] } };
	readonly electronSession: Session;
	/** BrowserSession の id（タブを開くときに使う）。 */
	readonly browserSessionId: string;
}

const WINDOW_ID_CURRENT = -2;
/**
 * 新しいタブがエージェントのものかは、workbench の台帳が少し後に知らせる。それまで一覧にもイベントにも出さない。
 * 時間の仮定で、保証ではない（目印がこれより遅れたら、それまでの間はタブとして扱う。目印が届いた時点から
 * 一覧とイベントから外す）。
 */
const CREATED_ANNOUNCE_DELAY_MS = 3_000;

type Tab = Record<string, unknown>;

interface ITabEntry {
	readonly webContents: WebContents;
	readonly windowId: number;
	readonly windowType: 'normal' | 'popup';
	readonly index: number;
	readonly active: boolean;
	readonly view?: IParadisTabView;
	readonly popout?: BrowserWindow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Chrome の match pattern に URL が当たるか（`<all_urls>`・`*://*.example.com/*` など）。 */
export function paradisMatchesUrlPattern(pattern: string, rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	const scheme = url.protocol.slice(0, -1);
	if (pattern === '<all_urls>') {
		return ['http', 'https', 'ws', 'wss', 'file', 'ftp'].includes(scheme);
	}
	const parts = /^(?<scheme>\*|https?|wss?|file|ftp):\/\/(?<host>\*|\*\.[^/*]+|[^/*]+)?(?<path>\/.*)$/.exec(pattern);
	if (!parts?.groups) {
		return false;
	}
	const { scheme: wantScheme, host: wantHost = '', path: wantPath } = parts.groups;
	const schemeOk = wantScheme === '*' ? ['http', 'https', 'ws', 'wss'].includes(scheme) : wantScheme === scheme;
	const host = url.hostname.toLowerCase();
	const wanted = (wantHost ?? '').toLowerCase();
	const hostOk = wanted === '*' || (wanted.startsWith('*.') ? host === wanted.slice(2) || host.endsWith(wanted.slice(1)) : host === wanted || (scheme === 'file' && wanted === ''));
	const escaped = wantPath.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
	return schemeOk && hostOk && new RegExp(`^${escaped}$`).test(`${url.pathname}${url.search}`);
}

/** 拡張機能がタブの URL とタイトルを見てよいか（"tabs" 権限、サイトの権限、自分のページ）。 */
export function paradisCanSeeTabUrl(extension: IParadisApiExtension, url: string): boolean {
	if (url.startsWith(`chrome-extension://${extension.id}/`)) {
		return true;
	}
	const list = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
	const permissions = list(extension.manifest.permissions);
	if (permissions.includes('tabs')) {
		return true;
	}
	const patterns = [...list(extension.manifest.host_permissions), ...permissions.filter(permission => permission.includes('://') || permission === '<all_urls>')];
	return patterns.some(pattern => paradisMatchesUrlPattern(pattern, url));
}

/** タブの title の照合（Chrome の tabs.query の title は `*` を使えるパターン）。 */
function matchesGlob(pattern: string, value: string): boolean {
	return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(value);
}

/** Chrome の frameId: タブの一番外のフレームは 0、それ以外は frame tree node の id。 */
export function paradisChromeFrameId(frame: WebFrameMain): number {
	return frame.parent ? frame.frameTreeNodeId : 0;
}

export class ParadisBrowserExtensionTabs implements IDisposable {

	private readonly _disposables = new DisposableStore();
	private readonly _sessions = new Map<Session, IParadisTabSession>();
	/** タブとして知らせた（エージェントのタブではないと分かった）ビュー。 */
	private readonly _announced = new Set<string>();
	/** イベントを見ているビュー。 */
	private readonly _observed = new Set<string>();
	/** ポップアップを開いた拡張機能（ポップアップ → 拡張機能の id）。 */
	private readonly _popoutOwners = new Map<BrowserWindow, string>();
	/** windows.create で開いた、拡張機能のページだけを出す窓（セッションごと）。 */
	private readonly _popouts = new Map<Session, Set<BrowserWindow>>();
	/** フレームの文書の id（frame tree node id → documentId）。 */
	private readonly _documentIds = new Map<number, string>();
	/** 最後に前に出た（表示された）タブ（ウィンドウ → WebContents の id）。 */
	private readonly _activeByWindow = new Map<number, number>();
	private _lastFocusedWindowId: number | undefined;
	private _grantedOrigins: (extension: IParadisApiExtension, session: Session) => readonly string[] = () => [];
	private _hasUserGesture: (caller: IParadisExtensionApiCaller) => boolean = () => false;
	/** captureVisibleTab の回数の上限（セッション → 拡張機能 → 残り）。 */
	private readonly _captureQuota = new WeakMap<ParadisApiSession, Map<string, { expiresAt: number; remaining: number }>>();
	/** ツールバーのボタンのポップアップの窓 → それを出した Para Code のウィンドウ（ポップアップはその窓の一部として扱う）。 */
	private readonly _windowAliases = new Map<number, number>();
	/** activeTab: ツールバーのボタンを押したタブ → URL とタイトルを見てよい拡張機能（タブが別の文書へ移る・閉じるまで）。 */
	private readonly _activeTabGrants = new Map<number, Set<string>>();
	private readonly _onDidResetTab = this._disposables.add(new Emitter<number>());
	/** タブが別の文書へ移った・閉じた（WebContents の id）。タブごとのボタンの値を消すのに使う。 */
	readonly onDidResetTab = this._onDidResetTab.event;
	private readonly _onDidChangeActiveTab = this._disposables.add(new Emitter<number>());
	/** そのウィンドウの前のタブ（拡張機能に見せるもの）が替わった（ウィンドウの id）。 */
	readonly onDidChangeActiveTab = this._onDidChangeActiveTab.event;
	/** 一番外のフレームで、文書の替わる移動が始まったことのあるタブ（見始めた時から）。 */
	private readonly _navigationStarted = new WeakSet<WebContents>();
	/** タブのグループ（拡張機能ごと・セッションごとのメモリ上の台帳。画面には出さない）。 */
	private readonly _groups = new ParadisTabGroupLedger();
	private readonly _onDidBecomeAgentTab = this._disposables.add(new Emitter<WebContents>());
	/** タブがエージェントのものだと分かった（エージェントが開いた・エージェントのタブから開いた。知らせが遅れて届いたときも）。 */
	readonly onDidBecomeAgentTab = this._onDidBecomeAgentTab.event;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _environment: IParadisTabEnvironment,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
		private readonly _createPopout: (session: Session, url: string, options: { readonly width?: number; readonly height?: number; readonly left?: number; readonly top?: number; readonly focused: boolean }) => BrowserWindow,
	) {
		this._disposables.add(_environment.onDidCreateView(({ view, existing }) => this._observe(view, existing)));
		this._disposables.add(_environment.onDidFocusWindow(windowId => this.noteWindowFocus(windowId)));
		this._disposables.add(this._onDidResetTab.event(tabId => this._activeTabGrants.delete(tabId)));
		this._disposables.add(paraOnDidMarkBrowserViewAgentTab(viewId => {
			const view = this._environment.listViews().find(candidate => candidate.id === viewId);
			if (view && !view.webContents.isDestroyed()) {
				this._onDidBecomeAgentTab.fire(view.webContents);
			}
		}));
		for (const view of _environment.listViews()) {
			this._observe(view, true, true);
		}
		// 外した拡張機能のグループを忘れる
		this._disposables.add(_host.onDidCloseContext((session, extensionId, connection) => {
			for (const [electronSession, entry] of this._sessions) {
				if (connection === undefined && entry.session === session) {
					this._groups.forgetExtension(electronSession, extensionId);
				}
			}
		}));
		this._registerNamespaces();
	}

	dispose(): void {
		this._disposables.dispose();
		for (const popouts of this._popouts.values()) {
			for (const window of popouts) {
				if (!window.isDestroyed()) {
					window.close();
				}
			}
		}
	}

	/** 拡張機能を読み込むセッションを覚える（外すときは返り値を dispose する）。 */
	attachSession(session: IParadisTabSession): IDisposable {
		this._sessions.set(session.electronSession, session);
		return toDisposable(() => {
			if (this._sessions.get(session.electronSession) === session) {
				this._sessions.delete(session.electronSession);
			}
		});
	}

	// --- タブの一覧 ---

	private _isUserTab(view: IParadisTabView): boolean {
		return !view.isAgentTab() && !view.webContents.isDestroyed();
	}

	/** そのセッションの、拡張機能に見せるタブ。 */
	private _tabsOf(session: Session): ITabEntry[] {
		const indexByWindow = new Map<number, number>();
		const entries: ITabEntry[] = [];
		for (const view of this._environment.listViews()) {
			// 知らせた（エージェントのタブではないと分かった）タブだけ。workbench の台帳がエージェントのタブだと
			// 知らせる前に、一覧に出てしまわないように
			if (view.webContents.isDestroyed() || view.webContents.session !== session || !this._announced.has(view.id) || !this._isUserTab(view)) {
				continue;
			}
			const index = indexByWindow.get(view.windowId) ?? 0;
			indexByWindow.set(view.windowId, index + 1);
			entries.push({ webContents: view.webContents, windowId: view.windowId, windowType: 'normal', index, active: this._isActive(view), view });
		}
		for (const popout of this._popouts.get(session) ?? []) {
			if (!popout.isDestroyed()) {
				entries.push({ webContents: popout.webContents, windowId: popout.id, windowType: 'popup', index: 0, active: true, popout });
			}
		}
		return entries;
	}

	private _isActive(view: IParadisTabView): boolean {
		// Chrome は 1 つの窓に前のタブが 1 つ。Para Code は分割で複数見えることがあるので、最後に前に出たものを選ぶ
		const remembered = this._activeByWindow.get(view.windowId);
		if (remembered !== undefined) {
			return remembered === view.webContents.id;
		}
		return view.isVisible();
	}

	private _findTab(session: Session, tabId: number): ITabEntry | undefined {
		return this._tabsOf(session).find(entry => entry.webContents.id === tabId);
	}

	private _requireTab(caller: IParadisExtensionApiCaller, tabId: number): ITabEntry {
		const entry = this._findTab(this._electronSession(caller), tabId);
		if (!entry) {
			throw new ParadisExtensionApiError(`No tab with id: ${tabId}.`);
		}
		return entry;
	}

	private _electronSession(caller: IParadisExtensionApiCaller): Session {
		for (const [electronSession, entry] of this._sessions) {
			if (entry.session === caller.session) {
				return electronSession;
			}
		}
		throw new ParadisExtensionApiError('This extension context is not attached');
	}

	private _tabSession(caller: IParadisExtensionApiCaller): IParadisTabSession {
		const entry = this._sessions.get(this._electronSession(caller));
		if (!entry) {
			throw new ParadisExtensionApiError('This extension context is not attached');
		}
		return entry;
	}

	/** Chrome の形のタブ。URL とタイトルは見てよいときだけ入れる。 */
	private _describe(extension: IParadisApiExtension, entry: ITabEntry): Tab {
		const contents = entry.webContents;
		const url = contents.getURL();
		return {
			id: contents.id,
			index: entry.index,
			windowId: entry.windowId,
			active: entry.active,
			highlighted: entry.active,
			selected: entry.active,
			pinned: false,
			discarded: false,
			frozen: false,
			autoDiscardable: true,
			incognito: false,
			groupId: this._groups.groupOf(contents.session, extension.id, contents.id),
			status: contents.isLoading() ? 'loading' : 'complete',
			audible: contents.isCurrentlyAudible(),
			mutedInfo: { muted: contents.isAudioMuted() },
			...(paradisCanSeeTabUrl(extension, url) || this._activeTabGrants.get(contents.id)?.has(extension.id) || this._grantedOrigins(extension, contents.session).some(pattern => paradisMatchesUrlPattern(pattern, url)) ? { url, title: contents.getTitle() } : {}),
		};
	}

	/** 背景の処理の「今のウィンドウ」は、最後に使ったウィンドウ（拡張機能のポップアップを含む）。 */
	private _currentWindowId(): number | undefined {
		return this._lastFocusedWindowId ?? this._environment.lastActiveWindowId();
	}

	/**
	 * 新しいタブを置く Para Code のウィンドウ。ポップアップや DevTools にはエディタが無く、そこへ開いたタブは
	 * 誰にも見えないので、workbench のウィンドウだけから選ぶ。
	 */
	private _workbenchWindowId(): number | undefined {
		const workbench = new Set(this._environment.listWindows().map(window => window.id));
		return this._lastFocusedWindowId !== undefined && workbench.has(this._lastFocusedWindowId) ? this._lastFocusedWindowId : this._environment.lastActiveWindowId();
	}

	// --- イベント ---

	/** そのセッションに読み込んだ拡張機能ごとに、引数を作って出す（URL を見てよいかは拡張機能ごとに違う）。 */
	private _emitPerExtension(session: Session, namespace: string, event: string, argsFor: (extension: IParadisApiExtension) => readonly unknown[] | undefined): void {
		const entry = this._sessions.get(session);
		if (!entry) {
			return;
		}
		for (const extension of entry.session.extensions.getAllExtensions()) {
			const args = argsFor(extension);
			if (args) {
				this._host.emit({ session: entry.session, extensionId: extension.id }, namespace, event, args);
			}
		}
	}

	private _observe(view: IParadisTabView, existing: boolean, alreadyMarked = false): void {
		const contents = view.webContents;
		if (contents.isDestroyed() || this._observed.has(view.id)) {
			return;
		}
		this._observed.add(view.id);
		const disposables = new DisposableStore();
		this._disposables.add(disposables);
		const userTab = () => this._announced.has(view.id) && this._isUserTab(view) && this._sessions.has(contents.session);
		const describe = (extension: IParadisApiExtension) => {
			const entry = this._findTab(contents.session, contents.id);
			return entry ? this._describe(extension, entry) : undefined;
		};
		const announce = () => {
			if (contents.isDestroyed() || !this._isUserTab(view) || this._announced.has(view.id)) {
				return;
			}
			this._announced.add(view.id);
			if (!existing) {
				// 目印が遅れて届くエージェントのタブの URL を、最初の知らせで漏らさないよう、onCreated には URL と
				// タイトルを入れない（Chrome でも新しいタブの onCreated には読み込み前の URL が無いことがある）
				this._emitPerExtension(contents.session, 'tabs', 'onCreated', extension => {
					const tab = describe(extension);
					if (!tab) {
						return undefined;
					}
					const { url: _url, title: _title, ...withoutUrl } = tab;
					return [withoutUrl];
				});
			}
		};
		if (alreadyMarked) {
			announce();
		} else {
			// エージェントが開いたタブかは workbench の台帳が少し後に知らせる。それを待ってから扱う
			const timer = setTimeout(announce, CREATED_ANNOUNCE_DELAY_MS);
			disposables.add(toDisposable(() => clearTimeout(timer)));
		}
		const updated = (changeInfo: (extension: IParadisApiExtension, canSee: boolean) => Record<string, unknown> | undefined) => {
			if (!userTab()) {
				return;
			}
			this._emitPerExtension(contents.session, 'tabs', 'onUpdated', extension => {
				const tab = describe(extension);
				const change = tab ? changeInfo(extension, typeof tab.url === 'string') : undefined;
				return tab && change && Object.keys(change).length > 0 ? [contents.id, change, tab] : undefined;
			});
		};
		const on = (event: string, listener: (...args: never[]) => void) => {
			contents.on(event as 'did-start-loading', listener as () => void);
			disposables.add(toDisposable(() => {
				if (!contents.isDestroyed()) {
					contents.off(event as 'did-start-loading', listener as () => void);
				}
			}));
		};
		on('did-start-loading', () => updated(() => ({ status: 'loading' })));
		on('did-stop-loading', () => updated(() => ({ status: 'complete' })));
		on('page-title-updated', ((_event: unknown, title: string) => updated((_extension, canSee) => canSee ? { title } : undefined)) as never);
		on('did-navigate', ((_event: unknown, url: string) => {
			this._onDidResetTab.fire(contents.id);
			updated((_extension, canSee) => canSee ? { url } : undefined);
		}) as never);
		on('page-favicon-updated', ((_event: unknown, favicons: string[]) => updated((_extension, canSee) => canSee && favicons[0] ? { favIconUrl: favicons[0] } : undefined)) as never);
		on('audio-state-changed', ((event: { audible: boolean }) => updated(() => ({ audible: event.audible }))) as never);
		this._observeNavigation(view, disposables, userTab);
		on('did-start-navigation', ((details: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
			if (details.isMainFrame !== false && details.isSameDocument !== true) {
				this._navigationStarted.add(contents);
			}
		}) as never);
		disposables.add(view.onDidChangeVisibility(visible => {
			if (!visible || !userTab()) {
				return;
			}
			if (this._activeByWindow.get(view.windowId) === contents.id) {
				return;
			}
			this._activeByWindow.set(view.windowId, contents.id);
			this._onDidChangeActiveTab.fire(view.windowId);
			this._emitPerExtension(contents.session, 'tabs', 'onActivated', () => [{ tabId: contents.id, windowId: view.windowId }]);
		}));
		disposables.add(Event.once(view.onDidClose)(() => {
			this._onDidResetTab.fire(contents.id);
			const wasAnnounced = this._announced.delete(view.id);
			this._observed.delete(view.id);
			if (this._activeByWindow.get(view.windowId) === contents.id) {
				this._activeByWindow.delete(view.windowId);
				this._onDidChangeActiveTab.fire(view.windowId);
			}
			if (wasAnnounced && !view.isAgentTab() && this._sessions.has(contents.session)) {
				this._emitPerExtension(contents.session, 'tabs', 'onRemoved', () => [contents.id, { windowId: view.windowId, isWindowClosing: false }]);
			}
			this._forgetGroupedTab(contents.session, contents.id);
			this._disposables.delete(disposables);
		}));
	}

	/** フレームの今の文書の id（Chrome の documentId。別の文書へ移るたびに変わる）。 */
	private _documentId(frame: WebFrameMain): string {
		let id = this._documentIds.get(frame.frameTreeNodeId);
		if (!id) {
			id = randomBytes(16).toString('hex').toUpperCase();
			this._documentIds.set(frame.frameTreeNodeId, id);
		}
		return id;
	}

	private _frameFields(frame: WebFrameMain, withDocument: boolean): Record<string, unknown> {
		return {
			frameId: paradisChromeFrameId(frame),
			parentFrameId: frame.parent ? paradisChromeFrameId(frame.parent) : -1,
			...(withDocument ? { documentId: this._documentId(frame) } : {}),
			...(frame.parent ? { parentDocumentId: this._documentId(frame.parent) } : {}),
			frameType: frame.parent ? 'sub_frame' : 'outermost_frame',
			documentLifecycle: 'active',
		};
	}

	/** タブの移動のイベントを webNavigation にする（一番外のフレームとその中のフレーム）。 */
	private _observeNavigation(view: IParadisTabView, disposables: DisposableStore, userTab: () => boolean): void {
		const contents = view.webContents;
		const tabId = contents.id;
		const frameTreeNodeIds = new Set<number>();
		const committedUrlByFrame = new Map<number, string>();
		disposables.add(toDisposable(() => {
			for (const id of frameTreeNodeIds) {
				this._documentIds.delete(id);
			}
		}));
		const emit = (event: string, details: Record<string, unknown>) => {
			if (userTab()) {
				this._emitPerExtension(contents.session, 'webNavigation', event, () => [details]);
			}
		};
		const details = (frame: WebFrameMain, url = frame.url, withDocument = true): Record<string, unknown> => ({
			tabId,
			url,
			processId: frame.processId,
			...this._frameFields(frame, withDocument),
			timeStamp: Date.now(),
		});
		const live = (frame: WebFrameMain | null | undefined): frame is WebFrameMain => !!frame && !frame.isDestroyed();
		const on = (event: string, listener: (...args: never[]) => void) => {
			contents.on(event as 'did-start-loading', listener as () => void);
			disposables.add(toDisposable(() => {
				if (!contents.isDestroyed()) {
					contents.off(event as 'did-start-loading', listener as () => void);
				}
			}));
		};
		on('did-start-navigation', ((navigation: { url: string; isSameDocument: boolean; frame: WebFrameMain | null }) => {
			if (!navigation.isSameDocument && live(navigation.frame)) {
				emit('onBeforeNavigate', details(navigation.frame, navigation.url, false));
			}
		}) as never);
		on('did-frame-navigate', ((_event: unknown, url: string, _code: number, _status: string, _isMain: boolean, processId: number, routingId: number) => {
			const frame = this._frame(contents, processId, routingId);
			if (frame) {
				frameTreeNodeIds.add(frame.frameTreeNodeId);
				// 別の文書へ移った: 新しい文書の id にする
				this._documentIds.delete(frame.frameTreeNodeId);
				committedUrlByFrame.set(frame.frameTreeNodeId, url);
				emit('onCommitted', { ...details(frame, url), transitionType: 'link', transitionQualifiers: [] });
			}
		}) as never);
		on('did-navigate-in-page', ((_event: unknown, url: string, _isMain: boolean, processId: number, routingId: number) => {
			const frame = this._frame(contents, processId, routingId);
			if (!frame) {
				return;
			}
			const withoutHash = (value: string) => value.split('#')[0];
			const previous = committedUrlByFrame.get(frame.frameTreeNodeId);
			committedUrlByFrame.set(frame.frameTreeNodeId, url);
			const fragmentOnly = previous !== undefined && withoutHash(previous) === withoutHash(url);
			emit(fragmentOnly ? 'onReferenceFragmentUpdated' : 'onHistoryStateUpdated', { ...details(frame, url), transitionType: 'link', transitionQualifiers: [] });
		}) as never);
		on('dom-ready', () => {
			if (live(contents.mainFrame)) {
				emit('onDOMContentLoaded', details(contents.mainFrame));
			}
		});
		on('frame-created', ((_event: unknown, created: { frame: WebFrameMain | null }) => {
			const frame = created.frame;
			if (live(frame) && frame.parent) {
				frameTreeNodeIds.add(frame.frameTreeNodeId);
				frame.on('dom-ready', () => {
					if (live(frame)) {
						emit('onDOMContentLoaded', details(frame));
					}
				});
			}
		}) as never);
		on('did-frame-finish-load', ((_event: unknown, _isMain: boolean, processId: number, routingId: number) => {
			const frame = this._frame(contents, processId, routingId);
			if (frame) {
				emit('onCompleted', details(frame));
			}
		}) as never);
		on('did-fail-load', ((_event: unknown, _code: number, description: string, url: string, _isMain: boolean, processId: number, routingId: number) => {
			const frame = this._frame(contents, processId, routingId);
			if (frame) {
				emit('onErrorOccurred', { ...details(frame, url), error: description.startsWith('net::') ? description : `net::${description}` });
			}
		}) as never);
		on('did-create-window', ((window: BrowserWindow, created: { url: string }) => {
			emit('onCreatedNavigationTarget', { sourceTabId: tabId, sourceProcessId: contents.mainFrame.processId, sourceFrameId: 0, url: created.url, tabId: window.webContents.id, timeStamp: Date.now() });
		}) as never);
	}

	private _frame(contents: WebContents, processId: number, routingId: number): WebFrameMain | undefined {
		if (contents.isDestroyed()) {
			return undefined;
		}
		const frame = contents.mainFrame.framesInSubtree.find(candidate => candidate.processId === processId && candidate.routingId === routingId);
		return frame && !frame.isDestroyed() ? frame : undefined;
	}

	// --- 窓 ---

	/** そのセッションの拡張機能に見せる窓: そのセッションのタブがある Para Code のウィンドウと、ポップアップ。 */
	private _windowsOf(session: Session): { readonly window: BrowserWindow; readonly type: 'normal' | 'popup' }[] {
		const tabWindows = new Set(this._tabsOf(session).filter(entry => entry.windowType === 'normal').map(entry => entry.windowId));
		const current = this._currentWindowId();
		const windows = this._environment.listWindows()
			.filter(window => !window.isDestroyed() && (tabWindows.has(window.id) || window.id === current))
			.map(window => ({ window, type: 'normal' as const }));
		const popouts = [...(this._popouts.get(session) ?? [])].filter(window => !window.isDestroyed()).map(window => ({ window, type: 'popup' as const }));
		return [...windows, ...popouts];
	}

	private _describeWindow(caller: IParadisExtensionApiCaller, entry: { readonly window: BrowserWindow; readonly type: 'normal' | 'popup' }, populate: boolean): Record<string, unknown> {
		const { window } = entry;
		const bounds = window.getBounds();
		const state = window.isFullScreen() ? 'fullscreen' : window.isMinimized() ? 'minimized' : window.isMaximized() ? 'maximized' : 'normal';
		return {
			id: window.id,
			focused: window.isFocused(),
			top: bounds.y,
			left: bounds.x,
			width: bounds.width,
			height: bounds.height,
			incognito: false,
			type: entry.type,
			state,
			alwaysOnTop: window.isAlwaysOnTop(),
			...(populate ? { tabs: this._tabsOf(this._electronSession(caller)).filter(tab => tab.windowId === window.id).map(tab => this._describe(caller.extension, tab)) } : {}),
		};
	}

	private _requireWindow(caller: IParadisExtensionApiCaller, windowId: number) {
		const resolved = windowId === WINDOW_ID_CURRENT ? this._currentWindowId() : windowId;
		const entry = this._windowsOf(this._electronSession(caller)).find(candidate => candidate.window.id === resolved);
		if (!entry) {
			throw new ParadisExtensionApiError(`No window with id: ${windowId}.`);
		}
		return entry;
	}

	/** ウィンドウにフォーカスが移った（windows.onFocusChanged）。 */
	noteWindowFocus(focusedWindowId: number): void {
		// ツールバーのボタンのポップアップは、それを出したウィンドウの一部（Chrome と同じ。ポップアップから
		// tabs.query({ active: true, currentWindow: true }) で、ボタンを押したタブが見つかるように）
		const windowId = this._windowAliases.get(focusedWindowId) ?? focusedWindowId;
		if (this._lastFocusedWindowId === windowId) {
			return;
		}
		this._lastFocusedWindowId = windowId;
		for (const entry of this._sessions.values()) {
			if (this._windowsOf(entry.electronSession).some(window => window.window.id === windowId)) {
				this._emitPerExtension(entry.electronSession, 'windows', 'onFocusChanged', () => [windowId]);
			}
		}
	}

	/** ツールバーのボタンのポップアップの窓を、それを出したウィンドウの一部として扱う（外すときは返り値を dispose する）。 */
	treatWindowAsPartOf(popupWindowId: number, parentWindowId: number): IDisposable {
		this._windowAliases.set(popupWindowId, parentWindowId);
		return toDisposable(() => {
			if (this._windowAliases.get(popupWindowId) === parentWindowId) {
				this._windowAliases.delete(popupWindowId);
			}
		});
	}

	/**
	 * 利用者がそのタブのツールバーのボタンを押した: そのタブを、そのウィンドウの前のタブ・そのウィンドウを今の
	 * ウィンドウにする（分割で複数のタブが見えていても、押したタブを tabs.query の active にする）。
	 */
	noteUserActivatedTab(view: IParadisTabView): void {
		const contents = view.webContents;
		if (contents.isDestroyed() || !this._announced.has(view.id) || !this._isUserTab(view)) {
			return;
		}
		if (this._activeByWindow.get(view.windowId) !== contents.id) {
			this._activeByWindow.set(view.windowId, contents.id);
			this._onDidChangeActiveTab.fire(view.windowId);
			if (this._sessions.has(contents.session)) {
				this._emitPerExtension(contents.session, 'tabs', 'onActivated', () => [{ tabId: contents.id, windowId: view.windowId }]);
			}
		}
		this.noteWindowFocus(view.windowId);
	}

	/**
	 * activeTab: 利用者がそのタブで拡張機能のボタンを押した。manifest に activeTab があれば、そのタブの URL とタイトルを
	 * 見せる（タブが別の文書へ移る・閉じるまで）。スクリプトを入れる権限は与えられない（Electron の
	 * scripting.executeScript は manifest のサイトの権限しか見ない。Orca と同じ）。
	 */
	grantActiveTab(extension: IParadisApiExtension, tabId: number): void {
		const permissions = extension.manifest.permissions;
		if (!Array.isArray(permissions) || !permissions.includes('activeTab')) {
			return;
		}
		let grants = this._activeTabGrants.get(tabId);
		if (!grants) {
			grants = new Set();
			this._activeTabGrants.set(tabId, grants);
		}
		grants.add(extension.id);
	}

	/** 後から許したサイトの権限の引き方（permissions.request、場所ごと）。 */
	setGrantedOriginsLookup(lookup: (extension: IParadisApiExtension, session: Session) => readonly string[]): void {
		this._grantedOrigins = lookup;
	}

	/** 利用者の操作の中かの引き方（permissions が持つ記録。captureVisibleTab の回数の上限に使う）。 */
	setUserGestureLookup(lookup: (caller: IParadisExtensionApiCaller) => boolean): void {
		this._hasUserGesture = lookup;
	}

	/** 拡張機能に見せるタブの id（cookies.getAllCookieStores。エージェントのタブは入らない）。 */
	visibleTabIds(caller: IParadisExtensionApiCaller): number[] {
		return this._tabsOf(this._electronSession(caller)).map(entry => entry.webContents.id);
	}

	/** 呼び出し元のセッション（Electron の Session。cookies・downloads が使う）。 */
	electronSessionOf(caller: IParadisExtensionApiCaller): Session {
		return this._electronSession(caller);
	}

	/**
	 * tabs.captureVisibleTab: そのウィンドウの前のタブを撮る（Chrome と同じく `<all_urls>` か、そのタブの activeTab が要る。
	 * ほかの拡張機能のページとストアは撮らない）。撮れるのは拡張機能に見せるタブだけ（同じ場所の利用者のタブ。エージェントの
	 * タブ・ほかのプロファイルのタブは見えない）。エージェントが手にしている（共有中の）タブも撮らない（Q483 の考え方:
	 * 共有中のタブでは拡張機能の画面を止め、拡張機能のページも開かせない。共有中は、拡張機能がそのタブの上で使える力を
	 * 足さない）。拡張機能の操作の外では 1 秒に 2 回まで（Chrome の MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND）。
	 */
	private async _captureVisibleTab(caller: IParadisExtensionApiCaller, windowIdValue: number | undefined, options: Record<string, unknown>): Promise<string> {
		const format = options.format === undefined ? 'jpeg' : options.format;
		const quality = options.quality === undefined ? 90 : options.quality;
		if ((format !== 'jpeg' && format !== 'png') || typeof quality !== 'number' || !Number.isInteger(quality) || quality < 0 || quality > 100) {
			throw new ParadisExtensionApiError('Invalid image details');
		}
		const session = this._electronSession(caller);
		const windowId = windowIdValue === undefined || windowIdValue === WINDOW_ID_CURRENT ? this._currentWindowId() : windowIdValue;
		const entry = this._tabsOf(session).find(candidate => candidate.windowId === windowId && candidate.active);
		if (windowId === undefined || !entry) {
			throw new ParadisExtensionApiError(`No window with id: ${windowIdValue ?? WINDOW_ID_CURRENT}.`);
		}
		const contents = entry.webContents;
		const url = contents.getURL();
		const patterns = [...this._hostPatterns(caller.extension, session)];
		if (!patterns.includes('<all_urls>') && !this._activeTabGrants.get(contents.id)?.has(caller.extension.id)) {
			throw new ParadisExtensionApiError('Either the \'<all_urls>\' or \'activeTab\' permission is required.');
		}
		if (url.startsWith('chrome-extension://') && !url.startsWith(`chrome-extension://${caller.extension.id}/`)) {
			throw new ParadisExtensionApiError('Cannot access a chrome-extension:// URL of different extension');
		}
		if (paradisIsChromeWebStoreUrl(url)) {
			throw new ParadisExtensionApiError('The extensions gallery cannot be scripted.');
		}
		if (paradisIsExtensionPageHeld(contents)) {
			throw new ParadisExtensionApiError('Para Code does not let extensions capture a tab that is shared with an agent');
		}
		this._consumeCaptureQuota(caller);
		const image = await contents.capturePage();
		// 撮っている間に別のページへ移った・共有された・前のタブでなくなったら捨てる（確かめた後の別のページを渡さない）
		if (contents.isDestroyed() || contents.getURL() !== url || paradisIsExtensionPageHeld(contents) || !this._tabsOf(session).some(candidate => candidate.webContents === contents && candidate.windowId === windowId && candidate.active)) {
			throw new ParadisExtensionApiError('The tab changed while it was being captured');
		}
		if (image.isEmpty()) {
			throw new ParadisExtensionApiError('Internal error while trying to capture visible region of the current tab');
		}
		return format === 'png' ? `data:image/png;base64,${image.toPNG().toString('base64')}` : `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`;
	}

	private _consumeCaptureQuota(caller: IParadisExtensionApiCaller): void {
		if (this._hasUserGesture(caller)) {
			return;
		}
		const key = `${caller.extension.id}`;
		let bySession = this._captureQuota.get(caller.session);
		if (!bySession) {
			bySession = new Map();
			this._captureQuota.set(caller.session, bySession);
		}
		const now = Date.now();
		let quota = bySession.get(key);
		if (!quota || now > quota.expiresAt) {
			quota = { expiresAt: now + 1_000, remaining: 2 };
			bySession.set(key, quota);
		}
		if (quota.remaining === 0) {
			throw new ParadisExtensionApiError('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
		}
		quota.remaining--;
	}

	/** Para Code が見るサイトの権限（manifest と、後から許したもの）。 */
	private _hostPatterns(extension: IParadisApiExtension, session: Session): readonly string[] {
		const list = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
		return [...list(extension.manifest.host_permissions), ...list(extension.manifest.permissions).filter(permission => permission.includes('://') || permission === '<all_urls>'), ...this._grantedOrigins(extension, session)];
	}

	/**
	 * そのタブの URL（`url` を渡せば、これから移る先）へのサイトの権限（manifest・後から許したもの）があるか。今の URL なら、そのタブの
	 * activeTab でもよい（chrome.debugger が使う）。
	 */
	hasHostAccess(caller: IParadisExtensionApiCaller, contents: WebContents, url = contents.getURL()): boolean {
		return (url === contents.getURL() && this._activeTabGrants.get(contents.id)?.has(caller.extension.id) === true) || this._hostPatterns(caller.extension, contents.session).some(pattern => paradisMatchesUrlPattern(pattern, url));
	}

	/** タブの一番外の文書の id（別の文書へ移ると変わる。右クリックの項目を、移った後に押させないのに使う）。 */
	topDocumentId(contents: WebContents): string | undefined {
		return contents.isDestroyed() ? undefined : this._documentId(contents.mainFrame);
	}

	/** そのセッションの、拡張機能に見せるタブか（タブの id を指定した API の呼び出しを確かめる）。 */
	assertTab(caller: IParadisExtensionApiCaller, tabId: number): void {
		this._requireTab(caller, tabId);
	}

	/**
	 * 拡張機能に見せる利用者のタブ（エディタのタブ）か。エージェントのタブ、エージェントのものかがまだ分からない新しいタブ
	 * （知らせる前）、拡張機能の窓は含めない（ユーザースクリプトを入れてよいかに使う）。
	 */
	/** 見始めてから、一番外のフレームで文書の替わる移動が始まったか（新しいタブの置き換えは、始まっていたらしない）。 */
	hasStartedNavigation(contents: WebContents): boolean {
		return this._navigationStarted.has(contents);
	}

	/** 今のウィンドウ（tabs.query の currentWindow と同じ）。 */
	currentWindowId(): number | undefined {
		return this._currentWindowId();
	}

	/** そのウィンドウで見えているタブ（エージェントのタブ・知らせる前のタブも含む）。 */
	visibleViewsIn(windowId: number): IParadisTabView[] {
		return this._environment.listViews().filter(view => view.windowId === windowId && !view.webContents.isDestroyed() && view.isVisible());
	}

	/** 呼び出し元に見せるタブ（そのセッションの、知らせ済みの利用者のタブ。窓のポップアップは除く）。 */
	userViewOf(caller: IParadisExtensionApiCaller, tabId: number): IParadisTabView | undefined {
		return this._findTab(this._electronSession(caller), tabId)?.view;
	}

	/** そのウィンドウの前のタブ（拡張機能に見せる利用者のタブ。無ければ undefined）。 */
	activeTabOf(windowId: number): IParadisTabView | undefined {
		const tabId = this._activeByWindow.get(windowId);
		const view = tabId !== undefined ? this._environment.listViews().find(candidate => candidate.webContents.id === tabId) : undefined;
		return view && !view.webContents.isDestroyed() && this._announced.has(view.id) && this._isUserTab(view) ? view : undefined;
	}

	isAnnouncedUserTab(contents: WebContents): boolean {
		return !contents.isDestroyed() && this._findTab(contents.session, contents.id)?.view !== undefined;
	}

	/** Chrome の形のタブ（拡張機能に見せるタブでなければ undefined）。 */
	describeTab(extension: IParadisApiExtension, session: Session, tabId: number): Tab | undefined {
		const entry = this._findTab(session, tabId);
		return entry ? this._describe(extension, entry) : undefined;
	}

	/** 今のウィンドウの前のタブ（Para Code のエディタのタブだけ。窓のポップアップは除く）。 */
	activeEditorTab(caller: IParadisExtensionApiCaller): IParadisTabView | undefined {
		const windowId = this._currentWindowId();
		return this._tabsOf(this._electronSession(caller)).find(candidate => candidate.active && candidate.windowId === windowId && candidate.view)?.view;
	}

	/** 拡張機能のページから新しいタブを開く（ポップアップの target=_blank のリンクなど）。 */
	async openTabFor(caller: IParadisExtensionApiCaller, url: string): Promise<void> {
		await this._openTab(caller, this._requireOpenableUrl(caller, url), true);
	}

	/** 拡張機能を外した（削除・無効・SSH 先のためのトンネルが始まった）: その拡張機能のポップアップを閉じる。 */
	closePopoutsOf(session: Session, extensionId: string): void {
		for (const window of this._popouts.get(session) ?? []) {
			if (this._popoutOwners.get(window) === extensionId && !window.isDestroyed()) {
				window.close();
			}
		}
	}

	// --- 開く ---

	/** 拡張機能が開いてよい URL か（http(s)・about:blank・自分のページ。ほかの拡張機能のページや file: は開かせない）。 */
	private _requireOpenableUrl(caller: IParadisExtensionApiCaller, rawUrl: string | undefined): string {
		// chrome://newtab は Para Code の新しいタブ（空のタブ）として開く（Claude がタブを作るときに使う）
		if (rawUrl === undefined || rawUrl === '' || /^chrome:\/\/newtab\/?$/i.test(rawUrl)) {
			return 'about:blank';
		}
		let url: URL;
		try {
			// 相対の URL は拡張機能自身のページ
			url = new URL(rawUrl, `chrome-extension://${caller.extension.id}/`);
		} catch {
			throw new ParadisExtensionApiError(`Cannot open URL: ${rawUrl}`);
		}
		const ownPage = url.protocol === 'chrome-extension:' && url.host === caller.extension.id;
		if (!ownPage && url.protocol !== 'http:' && url.protocol !== 'https:' && url.href !== 'about:blank') {
			throw new ParadisExtensionApiError(`Cannot open URL: ${rawUrl}`);
		}
		return url.href;
	}

	private async _openTab(caller: IParadisExtensionApiCaller, url: string, active: boolean, windowId?: number): Promise<Tab> {
		const session = this._tabSession(caller);
		const existingWindow = this._tabsOf(session.electronSession).find(entry => entry.windowType === 'normal')?.windowId;
		const target = windowId ?? this._workbenchWindowId() ?? existingWindow;
		if (target === undefined) {
			throw new ParadisExtensionApiError('Para Code has no window to open a tab in');
		}
		const view = await this._environment.createTab(url, session.browserSessionId, target, !active);
		// 拡張機能が開いたタブは、待たずにタブとして扱う（エージェントのタブではない）
		this._announced.add(view.id);
		if (active) {
			this._environment.activateTab(view.windowId, view.id);
		}
		const entry = this._findTab(session.electronSession, view.webContents.id);
		return entry ? this._describe(caller.extension, entry) : { id: view.webContents.id, windowId: view.windowId, index: 0, active, pinned: false, highlighted: active, incognito: false, discarded: false };
	}

	private async _openPopout(caller: IParadisExtensionApiCaller, url: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this._electronSession(caller);
		const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
		const window = this._createPopout(session, url, { width: number(data.width), height: number(data.height), left: number(data.left), top: number(data.top), focused: data.focused !== false });
		let popouts = this._popouts.get(session);
		if (!popouts) {
			popouts = new Set();
			this._popouts.set(session, popouts);
		}
		popouts.add(window);
		this._popoutOwners.set(window, caller.extension.id);
		const windowId = window.id;
		const tabId = window.webContents.id;
		window.once('closed', () => {
			popouts.delete(window);
			this._popoutOwners.delete(window);
			this._forgetGroupedTab(session, tabId);
			if (this._sessions.has(session)) {
				this._emitPerExtension(session, 'tabs', 'onRemoved', () => [tabId, { windowId, isWindowClosing: true }]);
				this._emitPerExtension(session, 'windows', 'onRemoved', () => [windowId]);
			}
		});
		this._emitPerExtension(session, 'windows', 'onCreated', extension => [this._describeWindow({ ...caller, extension }, { window, type: 'popup' }, false)]);
		return this._describeWindow(caller, { window, type: 'popup' }, true);
	}

	// --- タブのグループ ---

	/** 閉じたタブをグループから抜き、空になったグループを tabGroups.onRemoved で知らせる。 */
	private _forgetGroupedTab(session: Session, tabId: number): void {
		const apiSession = this._sessions.get(session)?.session;
		for (const { extensionId, removed } of this._groups.forgetTab(session, tabId)) {
			if (apiSession) {
				for (const group of removed) {
					this._host.emit({ session: apiSession, extensionId }, 'tabGroups', 'onRemoved', [group]);
				}
			}
		}
	}

	/** グループの変化を、その拡張機能だけへ知らせる（グループはほかの拡張機能から見えない）。 */
	private _emitGroupChanges(caller: IParadisExtensionApiCaller, changes: IParadisTabGroupChanges): void {
		const target = { session: caller.session, extensionId: caller.extension.id };
		for (const group of changes.created) {
			this._host.emit(target, 'tabGroups', 'onCreated', [group]);
		}
		for (const { tabId, groupId } of changes.tabs) {
			const entry = this._findTab(this._electronSession(caller), tabId);
			if (entry) {
				this._host.emit(target, 'tabs', 'onUpdated', [tabId, { groupId }, this._describe(caller.extension, entry)]);
			}
		}
		for (const group of changes.removed) {
			this._host.emit(target, 'tabGroups', 'onRemoved', [group]);
		}
	}

	/** tabs.group（Chrome と違い、タブを別のウィンドウへ移さない）。 */
	private _group(caller: IParadisExtensionApiCaller, options: Record<string, unknown>): number {
		const ids = [options.tabIds].flat();
		if (ids.length === 0 || !ids.every(id => typeof id === 'number' && Number.isInteger(id) && id >= 0)) {
			throw new ParadisExtensionApiError('You must specify at least one tab.');
		}
		const groupId = options.groupId;
		const createProperties = options.createProperties;
		if (groupId !== undefined && createProperties !== undefined) {
			throw new ParadisExtensionApiError('Cannot specify \'createProperties\' along with a \'groupId\'.');
		}
		if (groupId !== undefined && typeof groupId !== 'number') {
			throw new ParadisExtensionApiError('Invalid groupId');
		}
		if (createProperties !== undefined && !isRecord(createProperties)) {
			throw new ParadisExtensionApiError('Invalid createProperties');
		}
		const entries = (ids as number[]).map(id => this._requireTab(caller, id));
		const requestedWindow = createProperties?.windowId;
		const windowId = typeof requestedWindow === 'number' ? this._requireWindow(caller, requestedWindow).window.id : entries[0].windowId;
		try {
			const result = this._groups.group(this._electronSession(caller), caller.extension.id, entries.map(entry => entry.webContents.id), groupId, windowId);
			this._emitGroupChanges(caller, result.changes);
			return result.groupId;
		} catch (error) {
			throw new ParadisExtensionApiError(error instanceof Error ? error.message : String(error));
		}
	}

	private _requireGroup(caller: IParadisExtensionApiCaller, groupId: number) {
		const group = this._groups.get(this._electronSession(caller), caller.extension.id, groupId);
		if (!group) {
			throw new ParadisExtensionApiError(`No group with id: ${groupId}.`);
		}
		return group;
	}

	// --- 名前空間 ---

	private _registerNamespaces(): void {
		const tabId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
		const optionalRecord = (value: unknown) => value === undefined || isRecord(value);

		this._host.registerNamespace('tabs', {
			methods: {
				query: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, (caller, query) => this._query(caller, query)),
				get: paradisDefineExtensionMethod(args => args.length === 1 && tabId(args[0]) ? [args[0]] as [number] : undefined, (caller, id) => this._describe(caller.extension, this._requireTab(caller, id))),
				// 呼び出し元のタブは main からは分からない（ページの fetch には WebContents が付かない）。背景の処理と同じく undefined
				getCurrent: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => undefined),
				create: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, (caller, properties) => {
					const url = typeof properties.url === 'string' ? properties.url : undefined;
					const requested = typeof properties.windowId === 'number' && properties.windowId !== WINDOW_ID_CURRENT ? this._requireWindow(caller, properties.windowId) : undefined;
					// ポップアップにはタブを置けない（エディタが無い）。そのときは Para Code のウィンドウに置く
					const windowId = requested?.type === 'normal' ? requested.window.id : undefined;
					return this._openTab(caller, this._requireOpenableUrl(caller, url), properties.active !== false, windowId);
				}),
				duplicate: paradisDefineExtensionMethod(args => args.length === 1 && tabId(args[0]) ? [args[0]] as [number] : undefined, (caller, id) => {
					const source = this._requireTab(caller, id);
					return this._openTab(caller, this._requireOpenableUrl(caller, source.webContents.getURL()), true, source.windowType === 'normal' ? source.windowId : undefined);
				}),
				remove: paradisDefineExtensionMethod(args => args.length === 1 && (tabId(args[0]) || (Array.isArray(args[0]) && args[0].every(tabId))) ? [args[0]] as [number | number[]] : undefined, async (caller, ids) => {
					const entries = [ids].flat().map(id => this._requireTab(caller, id));
					for (const entry of entries) {
						if (entry.popout) {
							entry.popout.close();
						} else if (entry.view) {
							await this._environment.closeTab(entry.view.id);
						}
					}
				}),
				update: paradisDefineExtensionMethod(args => {
					if (args.length === 1 && isRecord(args[0])) {
						return [undefined, args[0]] as [number | undefined, Record<string, unknown>];
					}
					return args.length === 2 && (args[0] === undefined || args[0] === null || tabId(args[0])) && isRecord(args[1]) ? [args[0] ?? undefined, args[1]] as [number | undefined, Record<string, unknown>] : undefined;
				}, (caller, id, properties) => this._update(caller, id, properties)),
				goBack: paradisDefineExtensionMethod(args => args.length <= 1 && (args[0] === undefined || tabId(args[0])) ? [args[0] as number | undefined] as [number | undefined] : undefined, (caller, id) => {
					const entry = id === undefined ? this._activeTab(caller) : this._requireTab(caller, id);
					entry.webContents.navigationHistory.goBack();
				}),
				goForward: paradisDefineExtensionMethod(args => args.length <= 1 && (args[0] === undefined || tabId(args[0])) ? [args[0] as number | undefined] as [number | undefined] : undefined, (caller, id) => {
					const entry = id === undefined ? this._activeTab(caller) : this._requireTab(caller, id);
					entry.webContents.navigationHistory.goForward();
				}),
				// (windowId?, options?) または (options?)
				captureVisibleTab: paradisDefineExtensionMethod(args => {
					const [first, second] = args;
					if (args.length > 2 || (first !== undefined && first !== null && typeof first !== 'number' && !isRecord(first)) || (second !== undefined && second !== null && !isRecord(second))) {
						return undefined;
					}
					return isRecord(first) ? [undefined, first] as [number | undefined, Record<string, unknown>] : [first ?? undefined, (second ?? {}) as Record<string, unknown>] as [number | undefined, Record<string, unknown>];
				}, (caller, windowId, options) => this._captureVisibleTab(caller, windowId, options)),
				group: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, options) => this._group(caller, options)),
				ungroup: paradisDefineExtensionMethod(args => args.length === 1 && (tabId(args[0]) || (Array.isArray(args[0]) && args[0].every(tabId))) ? [args[0]] as [number | number[]] : undefined, (caller, ids) => {
					const entries = [ids].flat().map(id => this._requireTab(caller, id));
					this._emitGroupChanges(caller, this._groups.ungroup(this._electronSession(caller), caller.extension.id, entries.map(entry => entry.webContents.id)));
				}),
			},
			events: ['onActivated', 'onCreated', 'onUpdated', 'onRemoved', 'onReplaced'],
		});

		// 拡張機能ごとのグループ（paradisBrowserExtensionTabGroups.ts）。グループは画面に出さない
		const groupId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
		this._host.registerNamespace('tabGroups', {
			permission: 'tabGroups',
			methods: {
				get: paradisDefineExtensionMethod(args => args.length === 1 && groupId(args[0]) ? [args[0]] as [number] : undefined, (caller, id) => this._requireGroup(caller, id)),
				query: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, (caller, query) => {
					const current = this._currentWindowId();
					return this._groups.list(this._electronSession(caller), caller.extension.id).filter(group =>
						(query.collapsed === undefined || group.collapsed === query.collapsed)
						&& (query.color === undefined || group.color === query.color)
						&& (query.title === undefined || (typeof query.title === 'string' && matchesGlob(query.title, group.title)))
						&& (query.windowId === undefined || group.windowId === (query.windowId === WINDOW_ID_CURRENT ? current : query.windowId))
						&& (query.shared === undefined || query.shared === false));
				}),
				update: paradisDefineExtensionMethod(args => args.length === 2 && groupId(args[0]) && isRecord(args[1]) ? [args[0], args[1]] as [number, Record<string, unknown>] : undefined, (caller, id, properties) => {
					this._requireGroup(caller, id);
					const { title, color, collapsed } = properties;
					if ((title !== undefined && typeof title !== 'string') || (color !== undefined && (typeof color !== 'string' || !PARADIS_TAB_GROUP_COLORS.includes(color))) || (collapsed !== undefined && typeof collapsed !== 'boolean')) {
						throw new ParadisExtensionApiError('Invalid update properties');
					}
					const group = this._groups.update(this._electronSession(caller), caller.extension.id, id, { title: typeof title === 'string' ? title : undefined, color: typeof color === 'string' ? color : undefined, collapsed: typeof collapsed === 'boolean' ? collapsed : undefined });
					this._host.emit({ session: caller.session, extensionId: caller.extension.id }, 'tabGroups', 'onUpdated', [group]);
					return group;
				}),
				// Para Code はタブを並べ替えない・別のウィンドウへ移さない。同じウィンドウなら何もせずに答える
				move: paradisDefineExtensionMethod(args => args.length === 2 && groupId(args[0]) && isRecord(args[1]) ? [args[0], args[1]] as [number, Record<string, unknown>] : undefined, (caller, id, properties) => {
					const group = this._requireGroup(caller, id);
					if (typeof properties.index !== 'number') {
						throw new ParadisExtensionApiError('Invalid move properties');
					}
					const windowId = properties.windowId === WINDOW_ID_CURRENT ? this._currentWindowId() : properties.windowId;
					if (windowId !== undefined && windowId !== group.windowId) {
						throw new ParadisExtensionApiError('Para Code cannot move a tab group to another window');
					}
					return group;
				}),
			},
			events: ['onCreated', 'onUpdated', 'onRemoved', 'onMoved'],
		});

		this._host.registerNamespace('windows', {
			methods: {
				getAll: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, (caller, options) => {
					const types = Array.isArray(options.windowTypes) ? options.windowTypes : undefined;
					return this._windowsOf(this._electronSession(caller)).filter(entry => !types || types.includes(entry.type)).map(entry => this._describeWindow(caller, entry, options.populate === true));
				}),
				get: paradisDefineExtensionMethod(args => args.length <= 2 && typeof args[0] === 'number' && optionalRecord(args[1]) ? [args[0], (args[1] ?? {}) as Record<string, unknown>] as [number, Record<string, unknown>] : undefined, (caller, windowId, options) => this._describeWindow(caller, this._requireWindow(caller, windowId), options.populate === true)),
				getCurrent: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, (caller, options) => this._describeWindow(caller, this._requireWindow(caller, WINDOW_ID_CURRENT), options.populate === true)),
				getLastFocused: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, (caller, options) => this._describeWindow(caller, this._requireWindow(caller, WINDOW_ID_CURRENT), options.populate === true)),
				create: paradisDefineExtensionMethod(args => args.length <= 1 && optionalRecord(args[0]) ? [(args[0] ?? {}) as Record<string, unknown>] as [Record<string, unknown>] : undefined, async (caller, data) => {
					if (data.incognito === true) {
						throw new ParadisExtensionApiError('Incognito windows are not supported');
					}
					if (data.tabId !== undefined) {
						throw new ParadisExtensionApiError('Moving a tab into a new window is not supported');
					}
					const urls = Array.isArray(data.url) ? data.url : typeof data.url === 'string' ? [data.url] : [];
					const url = this._requireOpenableUrl(caller, typeof urls[0] === 'string' ? urls[0] : undefined);
					// 拡張機能自身のページだけを出す小さな窓（Bitwarden の「別の窓で開く」など）。ウェブのページは
					// 窓を作らず、今のウィンドウのタブとして開く（Para Code のウィンドウを拡張機能に作らせない）
					if (url.startsWith(`chrome-extension://${caller.extension.id}/`)) {
						return this._openPopout(caller, url, data);
					}
					const tab = await this._openTab(caller, url, data.focused !== false);
					return this._describeWindow(caller, this._requireWindow(caller, tab.windowId as number), true);
				}),
				update: paradisDefineExtensionMethod(args => args.length === 2 && typeof args[0] === 'number' && isRecord(args[1]) ? [args[0], args[1]] as [number, Record<string, unknown>] : undefined, (caller, windowId, info) => {
					const entry = this._requireWindow(caller, windowId);
					// Para Code のウィンドウは前に出すことだけを受ける（動かす・大きさを変える・最小化はさせない）
					if (entry.type === 'popup') {
						const bounds = entry.window.getBounds();
						const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
						entry.window.setBounds({ x: number(info.left, bounds.x), y: number(info.top, bounds.y), width: number(info.width, bounds.width), height: number(info.height, bounds.height) });
						if (info.state === 'minimized') {
							entry.window.minimize();
						}
					}
					if (info.drawAttention !== undefined) {
						entry.window.flashFrame(info.drawAttention === true);
					}
					if (info.focused === true) {
						if (entry.window.isMinimized()) {
							entry.window.restore();
						}
						entry.window.focus();
					}
					return this._describeWindow(caller, entry, false);
				}),
				remove: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'number' ? [args[0]] as [number] : undefined, (caller, windowId) => {
					const entry = this._requireWindow(caller, windowId);
					if (entry.type !== 'popup') {
						throw new ParadisExtensionApiError('Extensions cannot close Para Code windows');
					}
					entry.window.close();
				}),
			},
			events: ['onCreated', 'onRemoved', 'onFocusChanged', 'onBoundsChanged'],
		});

		this._host.registerNamespace('webNavigation', {
			permission: 'webNavigation',
			methods: {
				getFrame: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, details) => {
					const frame = this._findFrame(caller, details);
					return frame ? { errorOccurred: false, url: frame.url, ...this._frameFields(frame, true) } : null;
				}),
				getAllFrames: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) && tabId(args[0].tabId) ? [args[0].tabId] as [number] : undefined, (caller, id) => {
					const entry = this._findTab(this._electronSession(caller), id);
					return entry ? entry.webContents.mainFrame.framesInSubtree.map(frame => ({ errorOccurred: false, url: frame.url, processId: frame.processId, ...this._frameFields(frame, true) })) : null;
				}),
			},
			events: ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCreatedNavigationTarget'],
		});
	}

	/** runtime.openOptionsPage（拡張機能のオプションのページを今のウィンドウのタブで開く）。 */
	async openOptionsPage(caller: IParadisExtensionApiCaller): Promise<void> {
		const manifest = caller.extension.manifest as { options_ui?: { page?: unknown }; options_page?: unknown };
		const page = manifest.options_ui?.page ?? manifest.options_page;
		if (typeof page !== 'string' || page.length === 0) {
			throw new ParadisExtensionApiError('This extension has no options page');
		}
		await this._openTab(caller, this._requireOpenableUrl(caller, page.replace(/^\/+/, '')), true);
	}

	private _activeTab(caller: IParadisExtensionApiCaller): ITabEntry {
		const windowId = this._currentWindowId();
		const entry = this._tabsOf(this._electronSession(caller)).find(candidate => candidate.active && candidate.windowId === windowId);
		if (!entry) {
			throw new ParadisExtensionApiError('No active tab');
		}
		return entry;
	}

	private async _update(caller: IParadisExtensionApiCaller, id: number | undefined, properties: Record<string, unknown>): Promise<Tab> {
		const entry = id === undefined ? this._activeTab(caller) : this._requireTab(caller, id);
		if (typeof properties.url === 'string') {
			const url = this._requireOpenableUrl(caller, properties.url);
			// ポップアップは拡張機能自身のページだけを出す（アドレスバーの無い窓でウェブのページを開かせない）
			if (entry.popout && !url.startsWith(`chrome-extension://${caller.extension.id}/`)) {
				throw new ParadisExtensionApiError('A popup window shows only the extension\'s own pages');
			}
			entry.webContents.loadURL(url).catch(error => this._logService.warn('[paradis] a browser extension could not navigate a tab', error));
		}
		if (typeof properties.muted === 'boolean') {
			entry.webContents.setAudioMuted(properties.muted);
		}
		if (properties.active === true || properties.highlighted === true) {
			if (entry.popout) {
				entry.popout.focus();
			} else if (entry.view) {
				this._environment.activateTab(entry.view.windowId, entry.view.id);
			}
		}
		return this._describe(caller.extension, this._requireTab(caller, entry.webContents.id));
	}

	private _query(caller: IParadisExtensionApiCaller, query: Record<string, unknown>): Tab[] {
		const session = this._electronSession(caller);
		const current = this._currentWindowId();
		const windowTypes = new Map(this._windowsOf(session).map(entry => [entry.window.id, entry.type]));
		const urlPatterns = typeof query.url === 'string' ? [query.url] : Array.isArray(query.url) ? query.url.filter((entry): entry is string => typeof entry === 'string') : undefined;
		return this._tabsOf(session)
			.map(entry => ({ entry, tab: this._describe(caller.extension, entry) }))
			.filter(({ entry, tab }) => {
				const checks: [string, (value: unknown) => boolean][] = [
					['active', value => entry.active === value],
					['highlighted', value => entry.active === value],
					['currentWindow', value => (entry.windowId === current) === value],
					['lastFocusedWindow', value => (entry.windowId === current) === value],
					['windowId', value => entry.windowId === (value === WINDOW_ID_CURRENT ? current : value)],
					['windowType', value => windowTypes.get(entry.windowId) === value],
					['status', value => tab.status === value],
					['index', value => entry.index === value],
					['pinned', value => value === false],
					['discarded', value => value === false],
					['frozen', value => value === false],
					['audible', value => tab.audible === value],
					['muted', value => (tab.mutedInfo as { muted: boolean }).muted === value],
					['groupId', value => tab.groupId === value],
					['title', value => typeof value === 'string' && typeof tab.title === 'string' && matchesGlob(value, tab.title)],
				];
				for (const [key, check] of checks) {
					if (query[key] !== undefined && !check(query[key])) {
						return false;
					}
				}
				// url で探すのは URL を見てよいタブだけ（Chrome と同じ）
				return !urlPatterns || (typeof tab.url === 'string' && urlPatterns.some(pattern => paradisMatchesUrlPattern(pattern, tab.url as string)));
			})
			.map(({ tab }) => tab)
			.sort((a, b) => (a.windowId as number) - (b.windowId as number) || (a.index as number) - (b.index as number));
	}

	/** getFrame はタブとフレームの id、または documentId だけで探す。 */
	private _findFrame(caller: IParadisExtensionApiCaller, details: Record<string, unknown>): WebFrameMain | undefined {
		const { tabId, frameId, documentId } = details;
		if (documentId === undefined && (typeof tabId !== 'number' || typeof frameId !== 'number')) {
			throw new ParadisExtensionApiError('Either documentId or both tabId and frameId must be given');
		}
		const session = this._electronSession(caller);
		const tabs = typeof tabId === 'number' ? this._tabsOf(session).filter(entry => entry.webContents.id === tabId) : this._tabsOf(session);
		const frames = tabs.flatMap(entry => entry.webContents.mainFrame.framesInSubtree);
		return frames.find(frame => (frameId === undefined || paradisChromeFrameId(frame) === frameId) && (documentId === undefined || this._documentId(frame) === documentId));
	}
}

