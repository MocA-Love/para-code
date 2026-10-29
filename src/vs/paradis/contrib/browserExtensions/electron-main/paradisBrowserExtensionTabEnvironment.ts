/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能のタブ・ウィンドウの API（paradisBrowserExtensionTabs.ts）が使う、main のサービスの口を作る。
// プロファイルの main（paradisRegisterBrowserProfiles）から呼ぶ。browserViewMainService などは型だけを読む
// （値を読むと browserSession.ts → 拡張機能の main → ここ、と読み込みが輪になるため）。

import { app, BrowserWindow, Notification, nativeImage, screen, type Session, type WebContents } from 'electron';
import { localize } from '../../../../nls.js';
import { join } from '../../../../base/common/path.js';
import type { IDialogMainService } from '../../../../platform/dialogs/electron-main/dialogMainService.js';
import type { IParadisPermissionPrompt } from './paradisBrowserExtensionPermissions.js';
import type { IParadisExtensionNotification, IParadisExtensionNotificationOptions } from './paradisBrowserExtensionServices.js';
import type { IParadisRect } from '../common/paradisBrowserExtensionAction.js';
import { paradisMarkBrowserExtensionWindow } from './paradisBrowserExtensionWindows.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableMap, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import type { BrowserView } from '../../../../platform/browserView/electron-main/browserView.js';
import type { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { paraIsAgentTabOrChild } from '../../../../platform/browserView/electron-main/paraBrowserViewLoadWatchdog.js';
import type { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import type { IParadisTabEnvironment, IParadisTabView } from './paradisBrowserExtensionTabs.js';

function handleOf(view: BrowserView): IParadisTabView {
	return {
		id: view.id,
		webContents: view.webContents,
		// タブは補助ウィンドウへ移ることがあるので、今そのタブを出しているウィンドウ（まだ出していなければ持ち主のウィンドウ）
		get windowId() {
			return view.getElectronWindow()?.id ?? view.host.windowId;
		},
		isAgentTab: () => view.owner.type === 'agent' || paraIsAgentTabOrChild(view.id),
		isVisible: () => view.getState().visible === true,
		onDidClose: view.onDidClose,
		onDidChangeVisibility: Event.map(view.onDidChangeVisibility, event => event.visible),
	};
}

/** main の BrowserView とウィンドウから、拡張機能のタブの口を作る（タブを前に出すことは呼び出し側が足す）。 */
export function paradisCreateBrowserExtensionTabEnvironment(browserViewMainService: IBrowserViewMainService, windowsMainService: IWindowsMainService): Omit<IParadisTabEnvironment, 'activateTab'> & IDisposable {
	const disposables = new DisposableStore();
	const views = new Map<string, IParadisTabView>();
	// ビューごとの購読（閉じたら外す。残すと閉じたビューを覚え続ける）
	const closeListeners = disposables.add(new DisposableMap<string>());
	const onDidCreateView = disposables.add(new Emitter<{ readonly view: IParadisTabView; readonly existing: boolean }>());
	const track = (view: BrowserView | undefined): IParadisTabView | undefined => {
		if (!view || view.webContents.isDestroyed()) {
			return undefined;
		}
		const existing = views.get(view.id);
		if (existing) {
			return existing;
		}
		const handle = handleOf(view);
		views.set(view.id, handle);
		closeListeners.set(view.id, Event.once(view.onDidClose)(() => {
			views.delete(view.id);
			closeListeners.deleteAndDispose(view.id);
		}));
		return handle;
	};
	disposables.add(browserViewMainService.onDidCreateBrowserView(created => {
		const handle = track(browserViewMainService.tryGetBrowserView(created.info.id));
		if (handle) {
			onDidCreateView.fire({ view: handle, existing: false });
		}
	}));
	// 拡張機能の管理ができる前に開いていたタブも見つけて知らせる
	void browserViewMainService.getBrowserViews().then(infos => {
		for (const info of infos) {
			const known = views.has(info.id);
			const handle = track(browserViewMainService.tryGetBrowserView(info.id));
			if (handle && !known) {
				onDidCreateView.fire({ view: handle, existing: true });
			}
		}
	});
	return {
		listViews: () => [...views.values()].filter(view => !view.webContents.isDestroyed()),
		onDidCreateView: onDidCreateView.event,
		listWindows: () => {
			const windows = new Map<number, BrowserWindow>();
			for (const codeWindow of windowsMainService.getWindows()) {
				if (codeWindow.win && !codeWindow.win.isDestroyed()) {
					windows.set(codeWindow.win.id, codeWindow.win);
				}
			}
			// 補助ウィンドウにあるタブのウィンドウも含める
			for (const view of views.values()) {
				const window = BrowserWindow.fromId(view.windowId);
				if (window && !window.isDestroyed()) {
					windows.set(window.id, window);
				}
			}
			return [...windows.values()];
		},
		lastActiveWindowId: () => windowsMainService.getLastActiveWindow()?.win?.id,
		// 新しいタブはいつも後ろで開く（前に出すときは呼び出し側が activateTab する）
		createTab: async (url, browserSessionId, windowId) => {
			const view = await browserViewMainService.createTarget(url, { host: { windowId }, owner: { type: 'user' }, session: browserSessionId });
			const handle = track(view);
			if (!handle) {
				throw new Error('The new tab did not open');
			}
			return handle;
		},
		closeTab: viewId => browserViewMainService.destroyBrowserView(viewId),
		onDidFocusWindow: Event.fromNodeEventEmitter<number>(app, 'browser-window-focus', (_event: unknown, window: BrowserWindow) => window.id),
		dispose: () => disposables.dispose(),
	};
}

/** 拡張機能だけのページを出す小さな窓（windows.create の popup）。 */
export function paradisCreateBrowserExtensionPopout(session: Session, url: string, options: { readonly width?: number; readonly height?: number; readonly left?: number; readonly top?: number; readonly focused: boolean }): BrowserWindow {
	const window = new BrowserWindow({
		width: Math.min(Math.max(options.width ?? 420, 200), 1600),
		height: Math.min(Math.max(options.height ?? 640, 200), 1200),
		...(options.left !== undefined && options.top !== undefined ? { x: options.left, y: options.top } : {}),
		show: false,
		autoHideMenuBar: true,
		webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false },
	});
	// 内蔵ブラウザのビューではないので、セッションの preload（preload-browserView.ts）を動かさない
	paradisMarkBrowserExtensionWindow(window.webContents);
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	// 拡張機能自身のページだけを出す（アドレスバーの無い窓でウェブのページを開かせない）
	// URL の origin は chrome-extension: では "null" になり、どの拡張機能のページも同じに見える。スキームと host で比べる
	const pageKey = (value: string) => {
		const parsed = new URL(value);
		return parsed.protocol === 'chrome-extension:' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
	};
	const own = pageKey(url);
	const stayOnExtension = (event: { preventDefault(): void }, target: string) => {
		try {
			if (pageKey(target) === own) {
				return;
			}
		} catch {
			// 読めない URL は止める
		}
		event.preventDefault();
	};
	window.webContents.on('will-navigate', (event, target) => stayOnExtension(event, target));
	window.webContents.on('will-redirect', (event, target) => stayOnExtension(event, target));
	window.once('ready-to-show', () => options.focused ? window.show() : window.showInactive());
	void window.loadURL(url);
	return window;
}

/** ツールバーのボタンのポップアップの窓（枠の無い、Para Code のウィンドウの子。中身に合わせて大きさを変える）。 */
export function paradisCreateBrowserExtensionActionPopup(parent: BrowserWindow, bounds: IParadisRect, session: Session): BrowserWindow {
	const window = new BrowserWindow({
		...bounds,
		parent,
		show: false,
		frame: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: true,
		webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
	});
	// 内蔵ブラウザのビューではないので、セッションの preload（preload-browserView.ts）を動かさない
	paradisMarkBrowserExtensionWindow(window.webContents);
	return window;
}

/** 画面の座標の四角がある画面の作業領域。 */
export function paradisWorkAreaFor(rect: IParadisRect): IParadisRect {
	return screen.getDisplayMatching(rect).workArea;
}

/** 権限の名前の、利用者に見せる言い方（知らないものは名前のまま）。 */
function permissionLabel(permission: string): string {
	switch (permission) {
		case 'cookies': return localize('paradis.browserExtensions.permission.cookies', "サイトの cookie の読み取りと変更");
		case 'downloads': return localize('paradis.browserExtensions.permission.downloads', "ファイルのダウンロード");
		case 'notifications': return localize('paradis.browserExtensions.permission.notifications', "通知の表示");
		case 'management': return localize('paradis.browserExtensions.permission.management', "ほかの拡張機能の有効・無効の切り替え");
		case 'tabs': return localize('paradis.browserExtensions.permission.tabs', "タブの URL とタイトルの読み取り");
		case 'contextMenus': return localize('paradis.browserExtensions.permission.contextMenus', "右クリックのメニューへの項目の追加");
		case 'clipboardRead': return localize('paradis.browserExtensions.permission.clipboardRead', "クリップボードの読み取り");
		case 'clipboardWrite': return localize('paradis.browserExtensions.permission.clipboardWrite', "クリップボードへの書き込み");
		case 'webNavigation': return localize('paradis.browserExtensions.permission.webNavigation', "ページの移動の読み取り");
		default: return permission;
	}
}

/** サイトの権限の、利用者に見せる言い方。 */
function originLabel(origin: string): string {
	return origin === '<all_urls>' || origin === '*://*/*'
		? localize('paradis.browserExtensions.permission.allSites', "すべてのサイトのデータの読み取りと変更")
		: localize('paradis.browserExtensions.permission.site', "{0} のデータの読み取りと変更", origin);
}

/** permissions.request の確認のダイアログ（Para Code の今のウィンドウの上。ウィンドウが無ければ断る）。 */
export function paradisCreateBrowserExtensionPermissionPrompt(dialogMainService: IDialogMainService, lastActiveWindow: () => BrowserWindow | undefined): (prompt: IParadisPermissionPrompt) => Promise<boolean> {
	return async prompt => {
		const window = lastActiveWindow();
		if (!window || window.isDestroyed()) {
			return false;
		}
		const items = [...prompt.add.permissions.map(permissionLabel), ...prompt.add.origins.map(originLabel)].slice(0, 20);
		const { response } = await dialogMainService.showMessageBox({
			type: 'question',
			message: localize('paradis.browserExtensions.permission.message', "「{0}」に次の権限を許しますか？", prompt.extensionName),
			detail: `${items.map(item => `・${item}`).join('\n')}\n\n${localize('paradis.browserExtensions.permission.detail', "このプロファイルのタブで使います。管理画面から拡張機能を削除すると、許した権限も消えます。")}`,
			buttons: [localize('paradis.browserExtensions.permission.allow', "許可"), localize('paradis.browserExtensions.permission.deny', "許可しない")],
			defaultId: 1,
			cancelId: 1,
			noLink: true,
		}, window);
		return response === 0;
	};
}

/** 拡張機能の通知（OS の通知）。通知が使えない環境では undefined。 */
export function paradisCreateBrowserExtensionNotification(options: IParadisExtensionNotificationOptions): IParadisExtensionNotification | undefined {
	if (!Notification.isSupported()) {
		return undefined;
	}
	const icon = options.iconPath ? nativeImage.createFromPath(options.iconPath) : undefined;
	const notification = new Notification({
		title: options.title,
		body: options.body,
		silent: options.silent,
		timeoutType: options.requireInteraction ? 'never' : 'default',
		...(icon && !icon.isEmpty() ? { icon } : {}),
		// 通知のボタンは macOS だけ（ほかでは本文を押すと拡張機能へ届く）
		...(process.platform === 'darwin' && options.buttons.length > 0 ? { actions: options.buttons.map(text => ({ type: 'button' as const, text })) } : {}),
	});
	return {
		on: ((event: 'click' | 'close' | 'failed' | 'action', listener: (index: number) => void) => {
			if (event === 'action') {
				notification.on('action', (_event, index) => listener(index));
			} else {
				notification.on(event as 'click', () => (listener as () => void)());
			}
		}) as IParadisExtensionNotification['on'],
		show: () => notification.show(),
		close: () => notification.close(),
		removeAllListeners: () => notification.removeAllListeners(),
	};
}

/** downloads.download の saveAs: 保存のダイアログ（そのタブのウィンドウの上）。 */
export function paradisCreateBrowserExtensionSavePathChooser(dialogMainService: IDialogMainService): (owner: WebContents, defaultName: string) => Promise<string | undefined> {
	return async (owner, defaultName) => {
		const window = BrowserWindow.fromWebContents(owner.hostWebContents ?? owner) ?? undefined;
		const name = defaultName.replace(/[\\/:*?"<>|\0]/g, '_').slice(0, 200) || 'download';
		const result = await dialogMainService.showSaveDialog({ defaultPath: join(app.getPath('downloads'), name) }, window);
		return result.canceled || !result.filePath ? undefined : result.filePath;
	};
}
