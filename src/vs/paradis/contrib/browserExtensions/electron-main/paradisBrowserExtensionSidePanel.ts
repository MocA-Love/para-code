/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.sidePanel（P9d）の main 側。Bitwarden・Stylus・DeepL・Grammarly などがサイドパネルに画面を出す。Electron に無いので
// Para Code が作る。決まり（設定の合わせ方・エラーの文・ボタンを押したときの優先）は Chromium の side_panel_api.cc と
// side_panel_service.cc に合わせる。
//  - パネルは、Para Code のウィンドウ（BrowserWindow）の中に置く WebContentsView。内蔵ブラウザのタブにはしない（タブにすると、
//    パネルから tabs.query({ active: true, currentWindow: true }) で操作したいページを探す拡張機能が、パネル自身を見つける）。
//    置き場所は、そのウィンドウの前のタブ（拡張機能に見せる利用者のタブ）を出している BrowserEditor の右側で、renderer の
//    contribution（../electron-browser/paradisBrowserExtensionSidePanel.ts）がタブの中身を右に寄せてあけた場所の大きさを送る
//  - 1 つのウィンドウに 1 つ（Chrome と同じ）。ウィンドウのどのタブでも出すもの（global）と、決まったタブでだけ出すもの
//    （contextual、open({ tabId }) で開いたもの）がある
//  - 前のタブがエージェントと共有中・エージェントのタブになったら、パネルを閉じる（Q483 の考え方: 共有中のタブを持つ場面では
//    拡張機能の画面を出さない）。自分では開き直さない。判定は {@link paradisSidePanelAllowedFor} の 1 か所
//  - パネルのページは拡張機能自身のページの間だけ移れる。target=_blank のリンクは、その場所の新しいタブで開く
//  - open() は利用者の操作の中だけ（main の入力の記録で決める）。ボタンを押したときに開く設定（openPanelOnActionClick）は
//    場所ごとに保存し（Chrome は拡張機能の設定として残す）、setOptions の値はメモリだけ（Chrome と同じ）

import * as electron from 'electron';
import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';
import { promises as fs } from 'fs';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { dirname } from '../../../../base/common/path.js';
import { paradisIsExtensionPageHeld, paradisIsExtensionUiAllowedWhileHeld, paradisOnDidChangeExtensionPageHold, paradisOnDidChangeExtensionUiAllowedWhileHeld } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import type { IParadisSidePanelRefusal } from '../common/paradisBrowserExtensions.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import type { IParadisTabView, ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';
import { paradisKeepOnExtensionPages, paradisMarkBrowserExtensionWindow } from './paradisBrowserExtensionWindows.js';

const DEFAULT_TAB = -1;
const WINDOW_ID_CURRENT = -2;
/** パネルの幅（CSS のピクセル）。 */
export const PARADIS_SIDE_PANEL_WIDTH = 360;

/** 拡張機能（Electron の Extension の、ここで使うところ）。 */
export interface IParadisSidePanelExtension extends IParadisApiExtension {
	readonly name: string;
}

/** 拡張機能の管理から渡すもの（テストでは偽物）。 */
export interface IParadisSidePanelEnvironment {
	findView(viewId: string): IParadisTabView | undefined;
	windowById(windowId: number): BrowserWindow | undefined;
	/** そのタブのセッションに入っている拡張機能と、その場所（拡張機能を入れない・SSH 先のトンネルのセッションなら undefined）。 */
	sessionOf(contents: WebContents): { readonly session: ParadisApiSession; readonly place: string; readonly extensions: readonly IParadisSidePanelExtension[] } | undefined;
	/** 利用者の操作の中か（main の入力の記録）。 */
	hasUserGesture(caller: IParadisExtensionApiCaller): boolean;
	nameOf(extension: IParadisSidePanelExtension): string;
	/** パネルの面を作る（テストでは偽物）。 */
	createView?(session: Session): WebContentsView;
}

/** renderer に見せるパネル（そのタブの横に出すもの）。 */
export interface IParadisSidePanelInfo {
	readonly extensionId: string;
	readonly name: string;
	readonly width: number;
}

/** renderer が送るパネルの場所（ウィンドウの中の CSS のピクセル）。 */
export interface IParadisSidePanelLayout {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly zoomFactor: number;
}

interface IPanelOptions {
	path?: string;
	enabled?: boolean;
}

interface IPanel {
	readonly windowId: number;
	readonly session: ParadisApiSession;
	readonly place: string;
	readonly extension: IParadisSidePanelExtension;
	/** 決まったタブでだけ出す（contextual）なら、そのタブ。 */
	readonly tabId: number | undefined;
	readonly path: string;
	view: WebContentsView | undefined;
	/** 最後に renderer が「出す」を送ってきたタブ（view の id）。「隠す」はこのタブからのものだけ受ける。 */
	shownFor: string | undefined;
	/** shownFor のタブが閉じたら隠す見張り（renderer から「隠す」が届かないときに備える）。 */
	shownForWatch: IDisposable | undefined;
	readonly disposables: DisposableStore;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 拡張機能自身のページか（chrome-extension: の origin は "null" になるので、スキームと host で比べる）。 */
function isPageOf(rawUrl: string, extensionId: string): boolean {
	try {
		const url = new URL(rawUrl);
		return url.protocol === 'chrome-extension:' && url.host === extensionId;
	} catch {
		return false;
	}
}

/** 記録に残す、URL のホスト名（読めなければスキームだけ）。 */
function hostOf(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		return url.host || url.protocol;
	} catch {
		return '(unreadable)';
	}
}

/**
 * そのタブの横に拡張機能のサイドパネルを出してよいか。エージェントのタブ（エージェントが開いたタブとその子）と、エージェントと
 * 共有中のタブの横には出さない（Q483 の考え方。決まりが変わったらここだけを直す）。共有中のタブは、設定「共有中のタブでも
 * 拡張機能の画面を出す」（Q527、既定はオフ）がオンなら出す。
 */
export function paradisSidePanelAllowedFor(view: Pick<IParadisTabView, 'isAgentTab'> & { readonly webContents: object }): boolean {
	return !view.isAgentTab() && (paradisIsExtensionUiAllowedWhileHeld() || !paradisIsExtensionPageHeld(view.webContents));
}

/** manifest の side_panel.default_path から作った設定（Chromium の GetPanelOptionsFromManifest）。 */
function optionsFromManifest(extension: IParadisApiExtension): IPanelOptions {
	const sidePanel = extension.manifest.side_panel;
	const path = isRecord(sidePanel) && typeof sidePanel.default_path === 'string' && sidePanel.default_path.length > 0 ? sidePanel.default_path : undefined;
	return path !== undefined ? { path, enabled: true } : {};
}

export class ParadisBrowserExtensionSidePanel implements IDisposable {

	private readonly _disposables = new DisposableStore();
	/** セッション → 拡張機能 → タブ（{@link DEFAULT_TAB} はどのタブでも）→ setOptions の値（メモリだけ）。 */
	private readonly _options = new WeakMap<object, Map<string, Map<number, IPanelOptions>>>();
	/** 場所 → 拡張機能の id → ボタンを押したときに開くか（保存する）。 */
	private _behavior: Record<string, Record<string, boolean>> = {};
	private _saving: Promise<void> = Promise.resolve();
	/** ウィンドウの id → 開いているパネル。 */
	private readonly _panels = new Map<number, IPanel>();
	private readonly _onDidChange = this._disposables.add(new Emitter<void>());
	/** パネルが開いた・閉じた・出す先のタブが替わった（renderer は見ているタブの分を取り直す）。 */
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidRefuse = this._disposables.add(new Emitter<IParadisSidePanelRefusal>());
	/** エージェントのタブ・共有中のタブなので、利用者が開こうとしたパネルを出さなかった（renderer がその理由を見せる）。 */
	readonly onDidRefuse: Event<IParadisSidePanelRefusal> = this._onDidRefuse.event;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _tabs: ParadisBrowserExtensionTabs,
		private readonly _environment: IParadisSidePanelEnvironment,
		private readonly _path: string,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
	) {
		this._register();
		// 前のタブが替わった: 出す先が替わる。共有の始まったタブ・エージェントのタブなら閉じる
		this._disposables.add(this._tabs.onDidChangeActiveTab(windowId => this._recheckWindow(windowId)));
		this._disposables.add(this._tabs.onDidBecomeAgentTab(() => this._recheckAll()));
		this._disposables.add(paradisOnDidChangeExtensionPageHold((_contents, isHeld) => {
			if (isHeld) {
				this._recheckAll();
			}
		}));
		// 設定をオフに戻した: 共有中のタブの横のパネルを閉じる
		this._disposables.add(paradisOnDidChangeExtensionUiAllowedWhileHeld(() => this._recheckAll()));
		this._disposables.add(this._host.onDidCloseContext((session, extensionId, connection) => {
			// 拡張機能を外した・無効にした: そのパネルを閉じる
			if (connection === undefined) {
				for (const [windowId, panel] of [...this._panels]) {
					if (panel.session === session && panel.extension.id === extensionId) {
						this._close(windowId);
					}
				}
			}
		}));
	}

	async load(): Promise<void> {
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this._path, 'utf8'));
			const behavior: Record<string, Record<string, boolean>> = {};
			if (isRecord(raw)) {
				for (const [place, byExtension] of Object.entries(raw)) {
					if (isRecord(byExtension)) {
						behavior[place] = Object.fromEntries(Object.entries(byExtension).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>;
					}
				}
			}
			this._behavior = behavior;
		} catch {
			this._behavior = {};
		}
	}

	dispose(): void {
		for (const windowId of [...this._panels.keys()]) {
			this._close(windowId, false);
		}
		this._disposables.dispose();
	}

	/** 拡張機能を外した: 保存した設定を忘れる。 */
	async forgetExtension(extensionId: string): Promise<void> {
		let changed = false;
		for (const byExtension of Object.values(this._behavior)) {
			if (byExtension[extensionId] !== undefined) {
				delete byExtension[extensionId];
				changed = true;
			}
		}
		if (changed) {
			await this._save();
		}
	}

	// --- 設定（Chromium の SidePanelService::GetOptions・SetOptions と同じ合わせ方）---

	private _stored(session: ParadisApiSession, extensionId: string): Map<number, IPanelOptions> | undefined {
		return this._options.get(session)?.get(extensionId);
	}

	/** その拡張機能の、そのタブ（無ければどのタブでも）での設定。 */
	getOptions(session: ParadisApiSession, extension: IParadisApiExtension, tabId: number | undefined): IPanelOptions {
		const stored = this._stored(session, extension.id);
		if (!stored) {
			return optionsFromManifest(extension);
		}
		if (tabId !== undefined && tabId !== DEFAULT_TAB) {
			const specific = stored.get(tabId);
			if (specific) {
				return { ...specific };
			}
		}
		const fallback = stored.get(DEFAULT_TAB);
		return fallback ? { ...fallback } : optionsFromManifest(extension);
	}

	private _setOptions(session: ParadisApiSession, extension: IParadisApiExtension, options: { tabId?: number; path?: string; enabled?: boolean }): void {
		let byExtension = this._options.get(session);
		if (!byExtension) {
			byExtension = new Map();
			this._options.set(session, byExtension);
		}
		let byTab = byExtension.get(extension.id);
		if (!byTab) {
			byTab = new Map();
			byExtension.set(extension.id, byTab);
		}
		const tabId = options.tabId ?? DEFAULT_TAB;
		const existing = byTab.get(tabId);
		if (existing) {
			if (options.path !== undefined) {
				existing.path = options.path;
			}
			if (options.enabled !== undefined) {
				existing.enabled = options.enabled;
			}
		} else if (tabId === DEFAULT_TAB) {
			// どのタブでもの設定が初めてなら、manifest の設定に重ねる
			const merged = optionsFromManifest(extension);
			if (options.path !== undefined) {
				merged.path = options.path;
			}
			merged.enabled = options.enabled ?? true;
			byTab.set(tabId, merged);
		} else {
			byTab.set(tabId, { ...(options.path !== undefined ? { path: options.path } : {}), enabled: options.enabled ?? true });
		}
		// 開いているパネルが出せなくなった（enabled: false）なら閉じる
		for (const [windowId, panel] of [...this._panels]) {
			if (panel.session === session && panel.extension.id === extension.id) {
				const current = this.getOptions(session, extension, panel.tabId);
				if (!current.enabled || current.path === undefined) {
					this._close(windowId);
				}
			}
		}
		this._onDidChange.fire();
	}

	/** ボタンを押したときにパネルを開くか（Chromium の OpenSidePanelOnIconClick）。 */
	opensOnActionClick(place: string, extensionId: string): boolean {
		return this._behavior[place]?.[extensionId] === true;
	}

	/**
	 * ツールバーのボタンを押した: ボタンでパネルを開く設定で、そのタブで出せるパネルがあれば、開く・閉じる（ポップアップより先。
	 * Chromium の ExtensionActionRunner と同じく、activeTab は与えない）。そうしたら true。
	 */
	toggleFromAction(view: IParadisTabView, session: ParadisApiSession, place: string, extension: IParadisSidePanelExtension): boolean {
		if (!this.opensOnActionClick(place, extension.id)) {
			return false;
		}
		const options = this.getOptions(session, extension, view.webContents.id);
		if (!options.enabled || options.path === undefined) {
			return false;
		}
		const open = this._panels.get(view.windowId);
		if (open && open.session === session && open.extension.id === extension.id) {
			this._close(view.windowId);
			return true;
		}
		this._open(view, session, place, extension, this._isContextual(session, extension, view.webContents.id) ? view.webContents.id : undefined);
		return true;
	}

	/** そのタブに、拡張機能が決めたタブだけの設定（setOptions({ tabId })）があるか。 */
	private _isContextual(session: ParadisApiSession, extension: IParadisApiExtension, tabId: number): boolean {
		const specific = this._stored(session, extension.id)?.get(tabId);
		return specific?.enabled === true && specific.path !== undefined;
	}

	// --- renderer から ---

	/** 拡張機能のメニューの「サイドパネルを開く」（利用者の操作）。 */
	openFromMenu(viewId: string, extensionId: string): boolean {
		const resolved = this._resolve(viewId, extensionId);
		if (!resolved) {
			return false;
		}
		const options = this.getOptions(resolved.session, resolved.extension, resolved.view.webContents.id);
		if (!options.enabled || options.path === undefined) {
			return false;
		}
		this._open(resolved.view, resolved.session, resolved.place, resolved.extension, this._isContextual(resolved.session, resolved.extension, resolved.view.webContents.id) ? resolved.view.webContents.id : undefined);
		return true;
	}

	/** そのタブでその拡張機能のサイドパネルを開けるか（ツールバーのメニューに出すか）。 */
	availableFor(view: IParadisTabView, session: ParadisApiSession, extension: IParadisApiExtension): boolean {
		const options = this.getOptions(session, extension, view.webContents.id);
		return options.enabled === true && options.path !== undefined && paradisSidePanelAllowedFor(view);
	}

	/** その場所でサイドパネルを出せる拡張機能か（メニューに出すか）。 */
	hasPanel(viewId: string, extensionId: string): boolean {
		const resolved = this._resolve(viewId, extensionId);
		if (!resolved) {
			return false;
		}
		const options = this.getOptions(resolved.session, resolved.extension, resolved.view.webContents.id);
		return options.enabled === true && options.path !== undefined;
	}

	/** そのタブの横に出すパネル（そのタブがウィンドウの前のタブで、出してよいときだけ）。 */
	panelFor(viewId: string): IParadisSidePanelInfo | undefined {
		const view = this._environment.findView(viewId);
		const panel = view ? this._panels.get(view.windowId) : undefined;
		if (!view || !panel || !this._showsIn(panel, view)) {
			return undefined;
		}
		return { extensionId: panel.extension.id, name: this._environment.nameOf(panel.extension), width: PARADIS_SIDE_PANEL_WIDTH };
	}

	/** renderer がパネルの場所を送った（undefined なら隠す。エディタが見えない・前面の表示が重なったとき）。 */
	layout(viewId: string, layout: IParadisSidePanelLayout | undefined): void {
		const view = this._environment.findView(viewId);
		const panel = view ? this._panels.get(view.windowId) : undefined;
		if (!view || !panel) {
			return;
		}
		if (!layout || ![layout.x, layout.y, layout.width, layout.height, layout.zoomFactor].every(value => typeof value === 'number' && Number.isFinite(value)) || layout.width <= 0 || layout.height <= 0) {
			// 隠すのは、そのタブの横に出してよいかに関わらず受ける（出してよくなくなった後に届く「隠す」を捨てると、パネルが残る）。
			// ただし最後に出したタブからのものだけ（前のタブのエディタから遅れて届く「隠す」で、今のタブの横のパネルを消さない）
			if (panel.shownFor === viewId) {
				this._hideShown(panel);
			}
			return;
		}
		if (!this._showsIn(panel, view)) {
			return;
		}
		const contentsView = this._ensureView(panel);
		if (!contentsView) {
			return;
		}
		contentsView.setBounds({
			x: Math.round(layout.x * layout.zoomFactor),
			y: Math.round(layout.y * layout.zoomFactor),
			width: Math.round(layout.width * layout.zoomFactor),
			height: Math.round(layout.height * layout.zoomFactor),
		});
		if (panel.shownFor !== viewId) {
			panel.shownForWatch?.dispose();
			panel.shownFor = viewId;
			panel.shownForWatch = view.onDidClose(() => {
				if (panel.shownFor === viewId && this._panels.get(panel.windowId) === panel) {
					this._hideShown(panel);
				}
			});
		}
		contentsView.setVisible(true);
	}

	/** 最後に出したタブの横のパネルを隠す。 */
	private _hideShown(panel: IPanel): void {
		panel.shownFor = undefined;
		panel.shownForWatch?.dispose();
		panel.shownForWatch = undefined;
		if (panel.view && !panel.view.webContents.isDestroyed()) {
			panel.view.setVisible(false);
		}
	}

	/** パネルの閉じるボタン。 */
	closeFromRenderer(viewId: string): void {
		const view = this._environment.findView(viewId);
		if (view && this._panels.has(view.windowId)) {
			this._close(view.windowId);
		}
	}

	// --- 開く・閉じる ---

	private _resolve(viewId: string, extensionId: string): { readonly view: IParadisTabView; readonly session: ParadisApiSession; readonly place: string; readonly extension: IParadisSidePanelExtension } | undefined {
		const view = typeof viewId === 'string' ? this._environment.findView(viewId) : undefined;
		if (!view || view.webContents.isDestroyed() || !paradisSidePanelAllowedFor(view)) {
			return undefined;
		}
		const info = this._environment.sessionOf(view.webContents);
		const extension = info?.extensions.find(candidate => candidate.id === extensionId);
		return info && extension ? { view, session: info.session, place: info.place, extension } : undefined;
	}

	/** そのタブの横にそのパネルを出すか（そのウィンドウの前のタブで、出してよく、設定が許すとき）。 */
	private _showsIn(panel: IPanel, view: IParadisTabView): boolean {
		const active = this._tabs.activeTabOf(view.windowId);
		if (!active || active.webContents !== view.webContents || !paradisSidePanelAllowedFor(view)) {
			return false;
		}
		if (panel.tabId !== undefined && panel.tabId !== view.webContents.id) {
			return false;
		}
		if (this._environment.sessionOf(view.webContents)?.session !== panel.session) {
			return false;
		}
		const options = this.getOptions(panel.session, panel.extension, view.webContents.id);
		return options.enabled === true && options.path !== undefined;
	}

	private _open(view: IParadisTabView, session: ParadisApiSession, place: string, extension: IParadisSidePanelExtension, tabId: number | undefined): void {
		if (!paradisSidePanelAllowedFor(view)) {
			// 拡張機能への答えは Chromium に無い断りなので、利用者には何も見えない。理由を renderer に見せてもらう
			this._onDidRefuse.fire({ viewId: view.id, name: this._environment.nameOf(extension) });
			throw new ParadisExtensionApiError('Para Code does not show extension panels next to a tab that an agent is using');
		}
		const options = this.getOptions(session, extension, tabId ?? view.webContents.id);
		if (options.path === undefined) {
			throw new ParadisExtensionApiError(`No active side panel for tabId: ${view.webContents.id}`);
		}
		const url = new URL(options.path.replace(/^\/+/, ''), `chrome-extension://${extension.id}/`).href;
		if (!isPageOf(url, extension.id)) {
			throw new ParadisExtensionApiError('The side panel must be a page of the extension');
		}
		const existing = this._panels.get(view.windowId);
		if (existing && existing.session === session && existing.extension.id === extension.id && existing.tabId === tabId && existing.path === url) {
			this._onDidChange.fire();
			return;
		}
		if (existing) {
			this._close(view.windowId);
		}
		const panel: IPanel = { windowId: view.windowId, session, place, extension, tabId, path: url, view: undefined, shownFor: undefined, shownForWatch: undefined, disposables: new DisposableStore() };
		this._panels.set(view.windowId, panel);
		this._emitPanel(panel, 'onOpened');
		this._onDidChange.fire();
	}

	/** パネルの面を作ってウィンドウに置く（最初に場所が届いたとき）。 */
	private _ensureView(panel: IPanel): WebContentsView | undefined {
		if (panel.view && !panel.view.webContents.isDestroyed()) {
			return panel.view;
		}
		const window = this._environment.windowById(panel.windowId);
		if (!window || window.isDestroyed()) {
			this._close(panel.windowId);
			return undefined;
		}
		const electronSession = panel.session as unknown as Session;
		const view = this._environment.createView?.(electronSession) ?? new electron.WebContentsView({ webPreferences: { session: electronSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
		panel.view = view;
		const contents = view.webContents;
		// 内蔵ブラウザのビューではないので、セッションの preload（preload-browserView.ts）を動かさない
		paradisMarkBrowserExtensionWindow(contents);
		contents.on('will-prevent-unload', event => event.preventDefault());
		// target=_blank のリンクは、その場所の新しいタブで開く（パネルの中でウェブのページを開かせない）
		contents.setWindowOpenHandler(({ url }) => {
			void this._tabs.openTabFor({ extension: panel.extension, session: panel.session, place: panel.place, connection: 'page-paracode-side-panel', fromWorker: false }, url)
				.catch(error => this._logService.warn('[paradis] a browser extension side panel could not open a tab', error));
			return { action: 'deny' };
		});
		paradisKeepOnExtensionPages(contents, target => isPageOf(target, panel.extension.id));
		contents.on('render-process-gone', (_event, details) => {
			this._logService.warn(`[paradis] a browser extension side panel's renderer is gone (extension: ${panel.extension.id}, reason: ${details.reason}, exitCode: ${details.exitCode})`);
			if (this._panels.get(panel.windowId) === panel) {
				this._close(panel.windowId);
			}
		});
		// パネルが埋めたウェブのページ（iframe）が読み込めなかったときの記録。URL はホスト名まで（パスや問い合わせに個人の情報が入りうる）
		const onFrameFailed = (errorCode: number, errorDescription: string, url: string, isMainFrame: boolean) => {
			if (!isMainFrame) {
				this._logService.warn(`[paradis] a frame in a browser extension side panel failed to load (extension: ${panel.extension.id}, host: ${hostOf(url)}, error: ${errorCode} ${errorDescription})`);
			}
		};
		contents.on('did-fail-load', (_event, errorCode, errorDescription, url, isMainFrame) => onFrameFailed(errorCode, errorDescription, url, isMainFrame));
		contents.on('did-fail-provisional-load', (_event, errorCode, errorDescription, url, isMainFrame) => onFrameFailed(errorCode, errorDescription, url, isMainFrame));
		const onClosed = () => {
			if (this._panels.get(panel.windowId) === panel) {
				this._close(panel.windowId, false);
			}
		};
		window.once('closed', onClosed);
		panel.disposables.add({ dispose: () => window.removeListener('closed', onClosed) });
		view.setVisible(false);
		window.contentView.addChildView(view);
		contents.loadURL(panel.path).catch((error: unknown) => this._logService.warn('[paradis] a browser extension side panel failed to load', error));
		return view;
	}

	private _close(windowId: number, notify = true): void {
		const panel = this._panels.get(windowId);
		if (!panel) {
			return;
		}
		this._panels.delete(windowId);
		panel.shownForWatch?.dispose();
		panel.shownForWatch = undefined;
		panel.disposables.dispose();
		const view = panel.view;
		panel.view = undefined;
		if (view) {
			const window = this._environment.windowById(windowId);
			try {
				if (window && !window.isDestroyed()) {
					window.contentView.removeChildView(view);
				}
			} catch {
				// ウィンドウが先に閉じた
			}
			if (!view.webContents.isDestroyed()) {
				view.webContents.close();
			}
		}
		if (notify) {
			this._emitPanel(panel, 'onClosed');
		}
		this._onDidChange.fire();
	}

	/**
	 * 前のタブが替わった・共有が始まった・エージェントのタブと分かった: そのウィンドウで見えているタブ（前のタブを含む）に、
	 * パネルを出してはいけないものがあれば閉じる（開き直さない）。それ以外は出す先を取り直させる。
	 */
	private _recheckWindow(windowId: number): void {
		if (!this._panels.has(windowId)) {
			return;
		}
		const active = this._tabs.activeTabOf(windowId);
		const views = [...this._tabs.visibleViewsIn(windowId), ...(active ? [active] : [])];
		if (views.some(view => !paradisSidePanelAllowedFor(view))) {
			this._close(windowId);
			return;
		}
		this._onDidChange.fire();
	}

	private _recheckAll(): void {
		for (const windowId of [...this._panels.keys()]) {
			this._recheckWindow(windowId);
		}
	}

	private _emitPanel(panel: IPanel, event: 'onOpened' | 'onClosed'): void {
		const path = new URL(panel.path).pathname.replace(/^\/+/, '');
		this._host.emit({ session: panel.session, extensionId: panel.extension.id }, 'sidePanel', event, [{ windowId: panel.windowId, ...(panel.tabId !== undefined ? { tabId: panel.tabId } : {}), path }]);
	}

	// --- chrome.sidePanel ---

	private _register(): void {
		const optionalInteger = (value: unknown): value is number | undefined => value === undefined || Number.isInteger(value);
		this._host.registerNamespace('sidePanel', {
			permission: 'sidePanel',
			methods: {
				setOptions: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, options) => {
					if (!optionalInteger(options.tabId) || (options.path !== undefined && typeof options.path !== 'string') || (options.enabled !== undefined && typeof options.enabled !== 'boolean')) {
						throw new ParadisExtensionApiError('Invalid arguments');
					}
					this._setOptions(caller.session, caller.extension, { tabId: options.tabId as number | undefined, path: options.path as string | undefined, enabled: options.enabled as boolean | undefined });
				}),
				getOptions: paradisDefineExtensionMethod(args => args.length <= 1 && (args[0] === undefined || isRecord(args[0])) ? [args[0] as Record<string, unknown> | undefined] as [Record<string, unknown> | undefined] : undefined, (caller, options) => {
					const tabId = options?.tabId;
					if (!optionalInteger(tabId)) {
						throw new ParadisExtensionApiError('Invalid arguments');
					}
					const current = this.getOptions(caller.session, caller.extension, tabId);
					return { ...(tabId !== undefined ? { tabId } : {}), ...current };
				}),
				setPanelBehavior: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, async (caller, behavior) => {
					if (behavior.openPanelOnActionClick === undefined) {
						return;
					}
					if (typeof behavior.openPanelOnActionClick !== 'boolean') {
						throw new ParadisExtensionApiError('Invalid arguments');
					}
					const byExtension = this._behavior[caller.place] ?? {};
					byExtension[caller.extension.id] = behavior.openPanelOnActionClick;
					this._behavior[caller.place] = byExtension;
					await this._save();
				}),
				getPanelBehavior: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => ({ openPanelOnActionClick: this.opensOnActionClick(caller.place, caller.extension.id) })),
				getLayout: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, () => ({ side: 'right' })),
				open: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, options) => {
					if (!this._environment.hasUserGesture(caller)) {
						throw new ParadisExtensionApiError('`sidePanel.open()` may only be called in response to a user gesture.');
					}
					const { tabId, windowId } = options;
					if (!optionalInteger(tabId) || !optionalInteger(windowId)) {
						throw new ParadisExtensionApiError('Invalid arguments');
					}
					if (tabId === undefined && windowId === undefined) {
						throw new ParadisExtensionApiError('At least one of `tabId` and `windowId` must be provided');
					}
					if (tabId !== undefined) {
						const view = this._tabs.userViewOf(caller, tabId);
						if (!view || (windowId !== undefined && windowId !== WINDOW_ID_CURRENT && windowId !== view.windowId)) {
							throw new ParadisExtensionApiError(`No tab with id: ${tabId}.`);
						}
						const options = this.getOptions(caller.session, caller.extension, tabId);
						if (!options.enabled || options.path === undefined) {
							throw new ParadisExtensionApiError(`No active side panel for tabId: ${tabId}`);
						}
						this._open(view, caller.session, caller.place, caller.extension as IParadisSidePanelExtension, this._isContextual(caller.session, caller.extension, tabId) ? tabId : undefined);
						return;
					}
					const resolvedWindow = windowId === WINDOW_ID_CURRENT ? this._tabs.currentWindowId() : windowId;
					const view = resolvedWindow !== undefined ? this._tabs.activeTabOf(resolvedWindow) : undefined;
					if (resolvedWindow === undefined || !this._environment.windowById(resolvedWindow)) {
						throw new ParadisExtensionApiError(`No window with id: ${windowId}.`);
					}
					const global = this.getOptions(caller.session, caller.extension, undefined);
					if (!view || !global.enabled || global.path === undefined || this._environment.sessionOf(view.webContents)?.session !== caller.session) {
						throw new ParadisExtensionApiError(`No active side panel for windowId: ${resolvedWindow}`);
					}
					this._open(view, caller.session, caller.place, caller.extension as IParadisSidePanelExtension, undefined);
				}),
				close: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, options) => {
					const { tabId, windowId } = options;
					if (!optionalInteger(tabId) || !optionalInteger(windowId)) {
						throw new ParadisExtensionApiError('Invalid arguments');
					}
					if (tabId === undefined && windowId === undefined) {
						throw new ParadisExtensionApiError('At least one of `tabId` and `windowId` must be provided');
					}
					if (tabId !== undefined) {
						const view = this._tabs.userViewOf(caller, tabId);
						if (!view) {
							throw new ParadisExtensionApiError(`No tab with id: ${tabId}.`);
						}
						const panel = this._panels.get(view.windowId);
						if (!panel || panel.session !== caller.session || panel.extension.id !== caller.extension.id || panel.tabId !== tabId) {
							throw new ParadisExtensionApiError(`No active tab-specific side panel for tabId: ${tabId}`);
						}
						this._close(view.windowId);
						return;
					}
					const resolvedWindow = windowId === WINDOW_ID_CURRENT ? this._tabs.currentWindowId() : windowId;
					const panel = resolvedWindow !== undefined ? this._panels.get(resolvedWindow) : undefined;
					if (resolvedWindow === undefined || !panel || panel.session !== caller.session || panel.extension.id !== caller.extension.id || panel.tabId !== undefined) {
						throw new ParadisExtensionApiError(`No active side panel for windowId: ${resolvedWindow ?? windowId}`);
					}
					this._close(resolvedWindow);
				}),
			},
			events: ['onOpened', 'onClosed'],
		});
	}

	private _save(): Promise<void> {
		const state = JSON.stringify(this._behavior);
		this._saving = this._saving.then(async () => {
			await fs.mkdir(dirname(this._path), { recursive: true });
			await fs.writeFile(`${this._path}.tmp`, state);
			await fs.rename(`${this._path}.tmp`, this._path);
		}).catch(error => this._logService.warn('[paradis] could not save the browser extension side panel settings', error));
		return this._saving;
	}
}
