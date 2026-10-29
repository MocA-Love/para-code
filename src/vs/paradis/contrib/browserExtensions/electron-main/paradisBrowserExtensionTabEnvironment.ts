/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 拡張機能のタブ・ウィンドウの API（paradisBrowserExtensionTabs.ts）が使う、main のサービスの口を作る。
// プロファイルの main（paradisRegisterBrowserProfiles）から呼ぶ。browserViewMainService などは型だけを読む
// （値を読むと browserSession.ts → 拡張機能の main → ここ、と読み込みが輪になるため）。

import { app, BrowserWindow, type Session } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import type { BrowserView } from '../../../../platform/browserView/electron-main/browserView.js';
import type { IBrowserViewMainService } from '../../../../platform/browserView/electron-main/browserViewMainService.js';
import { paraIsAgentTabOrChild } from '../../../../platform/browserView/electron-main/paraBrowserViewLoadWatchdog.js';
import type { IWindowsMainService } from '../../../../platform/windows/electron-main/windows.js';
import type { IParadisTabEnvironment, IParadisTabView } from './paradisBrowserExtensionTabs.js';

function handleOf(view: BrowserView): IParadisTabView {
	return {
		id: view.id,
		webContents: view.webContents,
		windowId: view.host.windowId,
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
	const onDidCreateView = disposables.add(new Emitter<IParadisTabView>());
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
		disposables.add(Event.once(view.onDidClose)(() => views.delete(view.id)));
		return handle;
	};
	disposables.add(browserViewMainService.onDidCreateBrowserView(created => {
		const handle = track(browserViewMainService.tryGetBrowserView(created.info.id));
		if (handle) {
			onDidCreateView.fire(handle);
		}
	}));
	// 起動の後、拡張機能の管理ができる前に開いたタブも数える
	void browserViewMainService.getBrowserViews().then(infos => {
		for (const info of infos) {
			track(browserViewMainService.tryGetBrowserView(info.id));
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
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.once('ready-to-show', () => options.focused ? window.show() : window.showInactive());
	void window.loadURL(url);
	return window;
}
