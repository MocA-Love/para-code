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
//
// 中身は各ウィンドウが送ってくる（paradisMenuBarFeed.contribution.ts）。使用量は出どころ（手元・SSH の
// 接続先）ごとに覚え、ウィンドウを閉じた後も古さを添えて出し続ける。

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
import {
	IParadisMenuBarCost,
	IParadisMenuBarInbox,
	IParadisMenuBarSettings,
	PARADIS_MENU_BAR_CHANNEL,
	PARADIS_MENU_BAR_ICON_SETTING,
	ParadisMenuBarRequest,
	paradisReadMenuBarSettings,
	paradisSanitizeMenuBarReport,
} from '../common/paradisMenuBar.js';
import { IParadisMenuBarBitmap, IParadisRgb, paradisRenderMenuBarBars, paradisRenderMenuBarMark, paradisRenderMenuBarRing, paradisRenderMenuBarRowBars } from '../common/paradisMenuBarIcon.js';
import { ParadisMenuBarAction, ParadisMenuBarMenuItem, paradisMenuBarMenuModel } from '../common/paradisMenuBarModel.js';
import {
	IParadisMenuBarMergedAccount,
	IParadisMenuBarStoredSource,
	paradisMenuBarHeadlineValues,
	paradisMenuBarTodayCost,
	paradisMenuBarUsageTitle,
	paradisMergeMenuBarUsage,
} from '../common/paradisMenuBarUsage.js';

/** Windows の通知領域のアイコンは 16px（macOS のメニューバーは 18pt）。 */
const WINDOWS_ICON_SCALE = 16 / 18;
/** 「何分前」や古さの表示を古くしないよう、中身があればこの間隔で組み直す。 */
const MENU_REFRESH_INTERVAL = 60_000;

const BLACK: IParadisRgb = { r: 0, g: 0, b: 0 };
const RED_LIGHT: IParadisRgb = { r: 0xff, g: 0x3b, b: 0x30 };
const RED_DARK: IParadisRgb = { r: 0xff, g: 0x45, b: 0x3a };
const BLUE_LIGHT: IParadisRgb = { r: 0x00, g: 0x7a, b: 0xff };
const BLUE_DARK: IParadisRgb = { r: 0x0a, g: 0x84, b: 0xff };
/** setTitle の色（ANSI）。上限に近い値だけ赤くする。 */
const ESCAPE = String.fromCharCode(27);
const ANSI_RED = `${ESCAPE}[31m`;
const ANSI_RESET = `${ESCAPE}[0m`;

export interface IParadisMenuBarChannelHost {
	registerChannel(channelName: string, channel: IServerChannel<string>): void;
}

type PendingRequest = Exclude<ParadisMenuBarRequest['type'], 'reveal'>;

class ParadisMenuBar extends Disposable {

	private tray: Tray | undefined;
	private inbox: IParadisMenuBarInbox = { attentionCount: 0, blockingCount: 0, items: [], revision: 0 };
	/** ウィンドウ（IPC の ctx）ごとの作業中のペインの数。 */
	private readonly workingByWindow = new Map<string, number>();
	/** 出どころごとの使用量。ウィンドウを閉じても残す。 */
	private readonly sources = new Map<string, IParadisMenuBarStoredSource>();
	private readonly costs = new Map<string, IParadisMenuBarCost>();
	private repaintScheduled = false;
	/** ウィンドウが無いときに押された操作。次に中身を送ってきたウィンドウに頼む。 */
	private pendingRequest: PendingRequest | undefined;

	private readonly _onDidRequest = this._register(new Emitter<ParadisMenuBarRequest>());
	readonly onDidRequest: Event<ParadisMenuBarRequest> = this._onDidRequest.event;

	constructor(
		private readonly windowsMainService: IWindowsMainService,
		private readonly configurationService: IConfigurationService,
		private readonly logService: ILogService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(PARADIS_MENU_BAR_ICON_SETTING) || e.affectsConfiguration('paradis.menuBar')) {
				this.schedule();
			}
		}));
		// ウィンドウが減ったら、そのウィンドウの作業中の数を外す。1 枚も無くなったら要対応の知らせは
		// 届かなくなる（台帳を読むのは renderer）ので、古い点と行を残さないよう空にする。使用量は残す。
		this._register(this.windowsMainService.onDidChangeWindowsCount(event => {
			const alive = new Set(this.windowsMainService.getWindows().map(window => `window:${window.id}`));
			for (const owner of [...this.workingByWindow.keys()]) {
				if (!alive.has(owner)) {
					this.workingByWindow.delete(owner);
				}
			}
			if (event.newCount === 0) {
				this.inbox = { attentionCount: 0, blockingCount: 0, items: [], revision: this.inbox.revision };
			}
			this.schedule();
		}));
		const onThemeUpdated = () => this.schedule();
		nativeTheme.on('updated', onThemeUpdated);
		this._register({ dispose: () => nativeTheme.removeListener('updated', onThemeUpdated) });
		this._register({ dispose: () => this.destroyTray() });
		const refresh = setInterval(() => {
			if (this.tray && (this.inbox.items.length > 0 || this.sources.size > 0)) {
				this.schedule();
			}
		}, MENU_REFRESH_INTERVAL);
		this._register({ dispose: () => clearInterval(refresh) });
		this.schedule();
	}

	/** あるウィンドウから中身が届いた。ウィンドウが無い間に押された操作があれば返り値で頼む。 */
	update(owner: string, value: unknown): { readonly request?: PendingRequest } {
		const report = paradisSanitizeMenuBarReport(value);
		// 各ウィンドウが同じ台帳から送るので、遅れて届いた古いものは捨てる。
		if (report.inbox.revision >= this.inbox.revision) {
			this.inbox = report.inbox;
		}
		this.workingByWindow.set(owner, report.working);
		if (report.usage) {
			const previous = this.sources.get(report.usage.key);
			// 同じ出どころを複数のウィンドウが送ってくる。新しい方を残す
			if (!previous || report.usage.fetchedAt >= previous.fetchedAt) {
				this.sources.set(report.usage.key, { ...report.usage, receivedAt: Date.now() });
			}
		}
		if (report.cost) {
			const previous = this.costs.get(report.cost.sourceKey);
			if (!previous || report.cost.fetchedAt >= previous.fetchedAt) {
				this.costs.set(report.cost.sourceKey, report.cost);
			}
		}
		this.schedule();
		const request = this.pendingRequest;
		this.pendingRequest = undefined;
		return request ? { request } : {};
	}

	private settings(): IParadisMenuBarSettings {
		return paradisReadMenuBarSettings(this.configurationService.getValue<boolean>(PARADIS_MENU_BAR_ICON_SETTING) === true, key => this.configurationService.getValue(key));
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
				this.logService.error('[paradisMenuBar] failed to update the menu bar icon', error);
			}
		});
	}

	private repaint(): void {
		const settings = this.settings();
		if (!(isMacintosh || isWindows) || !settings.iconEnabled) {
			this.destroyTray();
			return;
		}
		const now = Date.now();
		const accounts = paradisMergeMenuBarUsage([...this.sources.values()], settings.includeRemote);
		const image = this.createIcon(settings, accounts, now);
		if (!this.tray || this.tray.isDestroyed()) {
			this.tray = new Tray(image);
			if (isWindows) {
				// Windows では左クリックでアプリを前に出すのが通例（右クリックでメニュー）。
				this.tray.on('click', () => this.safely(() => this.openApp()));
			}
		} else {
			this.tray.setImage(image);
		}
		if (isMacintosh) {
			this.tray.setTitle(this.title(settings, accounts, now), { fontType: 'monospacedDigit' });
		}
		this.tray.setToolTip(this.inbox.attentionCount > 0 ? `Para Code (${this.inbox.attentionCount})` : 'Para Code');
		const working = [...this.workingByWindow.values()].reduce((sum, count) => sum + count, 0);
		const cost = paradisMenuBarTodayCost([...this.costs.values()], settings.includeRemote, now);
		const model = paradisMenuBarMenuModel({ inbox: this.inbox, working, accounts, cost, now }, settings);
		this.tray.setContextMenu(Menu.buildFromTemplate(model.map(item => this.toMenuItem(item, settings.plainMenu))));
	}

	/** 横の文字。 */
	private title(settings: IParadisMenuBarSettings, accounts: readonly IParadisMenuBarMergedAccount[], now: number): string {
		if (settings.title === 'attention') {
			return this.inbox.blockingCount > 0 ? String(this.inbox.blockingCount) : '';
		}
		if (settings.title !== 'usage' || settings.usageStyle === 'bars' || settings.usageStyle === 'ring') {
			return '';
		}
		return paradisMenuBarUsageTitle(accounts, settings, now)
			.map(segment => segment.hot && !settings.plainMenu ? `${ANSI_RED}${segment.text}${ANSI_RESET}` : segment.text)
			.join('  ');
	}

	private createIcon(settings: IParadisMenuBarSettings, accounts: readonly IParadisMenuBarMergedAccount[], now: number): NativeImage {
		const dark = nativeTheme.shouldUseDarkColors;
		const dotColor = this.inbox.blockingCount > 0 ? (dark ? RED_DARK : RED_LIGHT)
			: this.inbox.attentionCount > 0 ? (dark ? BLUE_DARK : BLUE_LIGHT)
				: undefined;
		if (isWindows) {
			// 通知領域のアイコンは正方形だけ。マークに点を重ねる
			const glyph = dark ? { r: 0xff, g: 0xff, b: 0xff } : { r: 0x1f, g: 0x1f, b: 0x1f };
			return this.image(scale => paradisRenderMenuBarMark(scale * WINDOWS_ICON_SCALE, glyph, dotColor), false);
		}
		// テンプレート画像は macOS が明暗に合わせて塗る。点を出すときだけ自分で色を合わせる
		const glyph = dotColor ? (dark ? { r: 0xff, g: 0xff, b: 0xff } : BLACK) : BLACK;
		const template = dotColor === undefined;
		if (settings.title === 'usage' && (settings.usageStyle === 'bars' || settings.usageStyle === 'ring')) {
			const values = paradisMenuBarHeadlineValues(accounts, settings.usageWindow, now);
			if (values.claude !== undefined || values.codex !== undefined) {
				return settings.usageStyle === 'bars'
					? this.image(scale => paradisRenderMenuBarBars(scale, glyph, dotColor, values.claude, values.codex), template)
					: this.image(scale => paradisRenderMenuBarRing(scale, glyph, dotColor, Math.max(values.claude ?? 0, values.codex ?? 0)), template);
			}
		}
		return this.image(scale => paradisRenderMenuBarMark(scale, glyph, dotColor), template);
	}

	/** 1倍と2倍（Retina）の両方を持つ画像を作る。 */
	private image(render: (scale: number) => IParadisMenuBarBitmap, template: boolean): NativeImage {
		const one = render(1);
		const two = render(2);
		const image = nativeImage.createFromBitmap(Buffer.from(one.data), { width: one.width, height: one.height, scaleFactor: 1 });
		const retina = nativeImage.createFromBitmap(Buffer.from(two.data), { width: two.width, height: two.height, scaleFactor: 2 });
		image.addRepresentation({ scaleFactor: 2, width: two.width, height: two.height, buffer: retina.toPNG() });
		if (isMacintosh) {
			image.setTemplateImage(template);
		}
		return image;
	}

	private toMenuItem(item: ParadisMenuBarMenuItem, plain: boolean): MenuItemConstructorOptions {
		switch (item.kind) {
			case 'separator': return { type: 'separator' };
			case 'header':
			case 'info':
				return { label: item.label, enabled: false };
			case 'entry': return { label: item.label, click: () => this.safely(() => this.requestFromWindow(windowId => ({ type: 'reveal', windowId, entryId: item.entryId }))) };
			case 'account': {
				const options: MenuItemConstructorOptions = { label: item.label, click: () => this.safely(() => this.runAction('openUsagePanel')) };
				if (!plain) {
					options.icon = this.image(scale => paradisRenderMenuBarRowBars(scale, BLACK, item.bars.fiveHour, item.bars.sevenDay), true);
					if (item.sublabel) {
						options.sublabel = item.sublabel;
					}
				}
				return options;
			}
			case 'submenu': return { label: item.label, submenu: item.items.map(child => this.toMenuItem(child, plain)) };
			case 'action': return { label: item.label, click: () => this.safely(() => this.runAction(item.action)) };
		}
	}

	private runAction(action: ParadisMenuBarAction): void {
		switch (action) {
			case 'openApp':
				this.openApp();
				return;
			case 'openUsagePanel':
			case 'openCostDashboard':
			case 'openSettings':
				this.requestFromWindow(windowId => ({ type: action, windowId }), true);
				return;
		}
	}

	/**
	 * 最後に使っていたウィンドウに処理を頼む。ペインへの移動はペインを持っているウィンドウが
	 * 自分で前に出る（台帳経由）ので、`focus` はウィンドウ自体を前に出したいときだけ。
	 */
	private requestFromWindow(create: (windowId: number) => ParadisMenuBarRequest, focus = false): void {
		const window = this.targetWindow();
		if (!window) {
			const request = create(0);
			if (request.type !== 'reveal') {
				this.pendingRequest = request.type;
			}
			void this.windowsMainService.openEmptyWindow({ context: OpenContext.MENU });
			return;
		}
		if (focus) {
			window.focus({ mode: FocusMode.Force });
		}
		this._onDidRequest.fire(create(window.id));
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
			this.logService.error('[paradisMenuBar] menu action failed', error);
		}
	}
}

class ParadisMenuBarChannel implements IServerChannel<string> {

	constructor(private readonly menuBar: ParadisMenuBar) { }

	listen<T>(_ctx: string, event: string): Event<T> {
		switch (event) {
			case 'onDidRequest': return this.menuBar.onDidRequest as Event<T>;
			default: throw new Error(`Event not found: ${event}`);
		}
	}

	async call<T>(ctx: string, command: string, arg?: unknown): Promise<T> {
		switch (command) {
			// ctx は renderer の IPC の `window:<id>`（vs/platform/ipc/electron-browser/mainProcessService.ts）
			case 'update': return this.menuBar.update(ctx, Array.isArray(arg) ? arg[0] : undefined) as T;
			default: throw new Error(`Method not found: ${command}`);
		}
	}
}

/**
 * メニューバーのアイコンとそのチャネルを登録する。設定がオフの間はアイコンを作らない
 * （チャネルは開けておき、renderer から届く中身だけ覚えておく）。
 */
export function paradisRegisterMenuBar(channelHost: IParadisMenuBarChannelHost, windowsMainService: IWindowsMainService, configurationService: IConfigurationService, logService: ILogService): IDisposable {
	const menuBar = new ParadisMenuBar(windowsMainService, configurationService, logService);
	channelHost.registerChannel(PARADIS_MENU_BAR_CHANNEL, new ParadisMenuBarChannel(menuBar));
	return menuBar;
}
