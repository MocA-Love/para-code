/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// メニューバー（macOS）・通知領域（Windows）の Para Code のアイコン（既定オフ）。
// app.ts の PARA-PATCH から1回だけ呼ばれる。
//
// 構成は Orca（stablyai/orca、MIT）の src/main/tray/system-tray.ts に倣う:
// - Tray はガベージコレクションで消えないよう、ここで参照を持ち続ける
// - `setImage` / `setContextMenu` は AppKit のコールバックの中から呼ぶと main が固まることがあるので、
//   必ず次の周回（setImmediate）で行う
// - メニューのクリックで例外を投げると main が落ちるので、すべて握ってログへ出す
// Linux は Tray の出方がデスクトップ環境でまちまちなので作らない。

import { Menu, MenuItemConstructorOptions, nativeImage, NativeImage, nativeTheme, Tray } from 'electron';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../../base/common/platform.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { FocusMode } from '../../../../platform/native/common/native.js';
import { ICodeWindow } from '../../../../platform/window/electron-main/window.js';
import { IWindowsMainService, OpenContext } from '../../../../platform/windows/electron-main/windows.js';
import { PARADIS_NOTIFICATION_MENU_BAR_SETTING } from '../common/paradisNotificationInbox.js';
import {
	IParadisTrayState,
	PARADIS_NOTIFICATION_TRAY_CHANNEL,
	ParadisTrayMenuItem,
	ParadisTrayRequest,
	paradisRenderTrayBell,
	paradisSanitizeTrayState,
	paradisTrayMenuModel,
} from '../common/paradisNotificationTray.js';

/** macOS のメニューバーのアイコンの大きさ（pt）。Windows の通知領域は 16px。 */
const MAC_ICON_SIZE = 18;
const WINDOWS_ICON_SIZE = 16;
/** メニューの「何分前」を古くしないよう、要対応がある間はこの間隔で組み直す。 */
const MENU_REFRESH_INTERVAL = 60_000;

export interface IParadisNotificationTrayChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

class ParadisNotificationTray extends Disposable {

	private tray: Tray | undefined;
	private state: IParadisTrayState = { attentionCount: 0, items: [], revision: 0 };
	private repaintScheduled = false;
	/**
	 * メニューの「アイコンを隠す」を押した。設定を書けるのは renderer だけなので、書き換わるまでの間
	 * アイコンを出さない。ウィンドウが1つも無ければ、次に中身を送ってきたウィンドウに書かせる。
	 */
	private hiddenByMenu = false;
	private pendingHide = false;

	private readonly _onDidRequest = this._register(new Emitter<ParadisTrayRequest>());
	readonly onDidRequest: Event<ParadisTrayRequest> = this._onDidRequest.event;

	constructor(
		private readonly windowsMainService: IWindowsMainService,
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_NOTIFICATION_MENU_BAR_SETTING)) {
				this.hiddenByMenu = false;
				this.schedule();
			}
		}));
		// ウィンドウが1つも無くなったら、要対応の知らせは届かなくなる（台帳を読むのは renderer）。
		// 古い赤い点と行を残さないよう空にする。
		this._register(this.windowsMainService.onDidChangeWindowsCount(event => {
			if (event.newCount === 0) {
				this.state = { attentionCount: 0, items: [], revision: this.state.revision };
				this.schedule();
			}
		}));
		const onThemeUpdated = () => this.schedule();
		nativeTheme.on('updated', onThemeUpdated);
		this._register({ dispose: () => nativeTheme.removeListener('updated', onThemeUpdated) });
		this._register({ dispose: () => this.destroyTray() });
		const refresh = setInterval(() => {
			if (this.tray && this.state.items.length > 0) {
				this.schedule();
			}
		}, MENU_REFRESH_INTERVAL);
		this._register({ dispose: () => clearInterval(refresh) });
		this.schedule();
	}

	/** renderer から中身が届いた。「アイコンを隠す」の書き換えを頼みたいときは返り値で伝える。 */
	update(value: unknown): { readonly hideIcon: boolean } {
		const state = paradisSanitizeTrayState(value);
		// 各ウィンドウが同じ台帳から送るので、遅れて届いた古いものは捨てる。
		if (state.revision >= this.state.revision) {
			this.state = state;
			this.schedule();
		}
		const hideIcon = this.pendingHide;
		this.pendingHide = false;
		return { hideIcon };
	}

	private get enabled(): boolean {
		return (isMacintosh || isWindows) && !this.hiddenByMenu && this.configurationService.getValue<boolean>(PARADIS_NOTIFICATION_MENU_BAR_SETTING) === true;
	}

	/** まとめて次の周回で描き直す（AppKit のコールバックの中で Tray を触らないため）。 */
	private schedule(): void {
		if (this.repaintScheduled) {
			return;
		}
		this.repaintScheduled = true;
		setImmediate(() => {
			this.repaintScheduled = false;
			if (this._store.isDisposed) {
				return;
			}
			try {
				this.repaint();
			} catch (error) {
				this.logService.error('[paradisNotificationTray] failed to update the tray icon', error);
			}
		});
	}

	private repaint(): void {
		if (!this.enabled) {
			this.destroyTray();
			return;
		}
		const image = this.createImage(this.state.attentionCount > 0);
		if (!this.tray || this.tray.isDestroyed()) {
			this.tray = new Tray(image);
			if (isWindows) {
				// Windows では左クリックでアプリを前に出すのが通例（右クリックでメニュー）。
				this.tray.on('click', () => this.safely(() => this.openApp()));
			}
		} else {
			this.tray.setImage(image);
		}
		this.tray.setToolTip(this.state.attentionCount > 0
			? `Para Code (${this.state.attentionCount})`
			: 'Para Code');
		this.tray.setContextMenu(Menu.buildFromTemplate(paradisTrayMenuModel(this.state, isMacintosh).map(item => this.toMenuItem(item))));
	}

	private toMenuItem(item: ParadisTrayMenuItem): MenuItemConstructorOptions {
		switch (item.kind) {
			case 'separator': return { type: 'separator' };
			case 'header': return { label: item.label, enabled: false };
			case 'entry': return { label: item.label, click: () => this.safely(() => this.requestFromWindow(windowId => ({ type: 'reveal', windowId, entryId: item.entryId }))) };
			case 'openInbox': return { label: item.label, click: () => this.safely(() => this.requestFromWindow(windowId => ({ type: 'openInbox', windowId }), true)) };
			case 'openApp': return { label: item.label, click: () => this.safely(() => this.openApp()) };
			case 'hideIcon': return { label: item.label, click: () => this.safely(() => this.hideFromMenu()) };
		}
	}

	/**
	 * 最後に使っていたウィンドウに処理を頼む。ペインへの移動はペインを持っているウィンドウが
	 * 自分で前に出る（台帳経由）ので、`focus` はウィンドウ自体を前に出したいときだけ。
	 */
	private requestFromWindow(create: (windowId: number) => ParadisTrayRequest, focus = false): void {
		const window = this.targetWindow();
		if (!window) {
			void this.windowsMainService.openEmptyWindow({ context: OpenContext.MENU });
			return;
		}
		if (focus) {
			window.focus({ mode: FocusMode.Force });
		}
		this._onDidRequest.fire(create(window.id));
	}

	/** アイコンはすぐに消し、設定の書き換えはウィンドウに頼む（無ければ次に開いたウィンドウに）。 */
	private hideFromMenu(): void {
		this.hiddenByMenu = true;
		this.schedule();
		const window = this.targetWindow();
		if (window) {
			this._onDidRequest.fire({ type: 'hideIcon', windowId: window.id });
		} else {
			this.pendingHide = true;
		}
	}

	/**
	 * 依頼を受け取れるウィンドウ。Agent Sessions ウィンドウは fork の通常ウィンドウ向けの機能を
	 * 読み込まないので（受け手がいない）外す。
	 */
	private targetWindow(): ICodeWindow | undefined {
		const isNormal = (window: ICodeWindow) => window.config?.isSessionsWindow !== true;
		const last = this.windowsMainService.getLastActiveWindow();
		return last && isNormal(last) ? last : this.windowsMainService.getWindows().find(isNormal);
	}

	private openApp(): void {
		const window = this.targetWindow();
		if (window) {
			window.focus({ mode: FocusMode.Force });
		} else {
			void this.windowsMainService.openEmptyWindow({ context: OpenContext.MENU });
		}
	}

	private createImage(attention: boolean): NativeImage {
		if (isMacintosh) {
			if (!attention) {
				// テンプレート画像: macOS がメニューバーの明暗に合わせて塗る
				const image = this.bitmap(MAC_ICON_SIZE, { r: 0, g: 0, b: 0 }, false);
				image.setTemplateImage(true);
				return image;
			}
			// 点を赤く出すためにテンプレートをやめるので、ベルの色は自分で明暗に合わせる
			const glyph = nativeTheme.shouldUseDarkColors ? { r: 0xff, g: 0xff, b: 0xff } : { r: 0, g: 0, b: 0 };
			const image = this.bitmap(MAC_ICON_SIZE, glyph, true);
			image.setTemplateImage(false);
			return image;
		}
		const glyph = nativeTheme.shouldUseDarkColors ? { r: 0xff, g: 0xff, b: 0xff } : { r: 0x1f, g: 0x1f, b: 0x1f };
		return this.bitmap(WINDOWS_ICON_SIZE, glyph, attention);
	}

	/** 1倍と2倍（Retina）の両方を持つ画像を作る。 */
	private bitmap(size: number, glyph: { r: number; g: number; b: number }, dot: boolean): NativeImage {
		const image = nativeImage.createFromBitmap(Buffer.from(paradisRenderTrayBell(size, glyph, dot)), { width: size, height: size, scaleFactor: 1 });
		const retina = nativeImage.createFromBitmap(Buffer.from(paradisRenderTrayBell(size * 2, glyph, dot)), { width: size * 2, height: size * 2, scaleFactor: 2 });
		image.addRepresentation({ scaleFactor: 2, width: size * 2, height: size * 2, buffer: retina.toPNG() });
		return image;
	}

	private destroyTray(): void {
		if (this.tray && !this.tray.isDestroyed()) {
			this.tray.destroy();
		}
		this.tray = undefined;
	}

	private safely(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.logService.error('[paradisNotificationTray] menu action failed', error);
		}
	}
}

class ParadisNotificationTrayChannel implements IServerChannel<string> {

	constructor(private readonly tray: ParadisNotificationTray) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidRequest': return this.tray.onDidRequest as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(_ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			case 'update': return this.tray.update(Array.isArray(arg) ? arg[0] : undefined) as T;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * メニューバーのアイコンとそのチャネルを登録する。設定がオフの間はアイコンを作らない
 * （チャネルは開けておき、renderer から届く中身だけ覚えておく）。
 */
export function paradisRegisterNotificationTray(channelHost: IParadisNotificationTrayChannelHost, windowsMainService: IWindowsMainService, configurationService: IConfigurationService, logService: ILogService): IDisposable {
	const tray = new ParadisNotificationTray(windowsMainService, configurationService, logService);
	channelHost.registerChannel(PARADIS_NOTIFICATION_TRAY_CHANNEL, new ParadisNotificationTrayChannel(tray));
	return tray;
}
