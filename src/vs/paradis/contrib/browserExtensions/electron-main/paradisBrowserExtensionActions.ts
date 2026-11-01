/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.
// Portions adapted from stablyai/orca (MIT, commit 4642bc00): src/main/browser/extensions/api/action.ts, src/main/browser/extensions/browser-extension-action-registry.ts, src/main/browser/extensions/browser-extension-action-icon.ts, src/main/browser/extensions/browser-extension-toolbar.ts, src/main/browser/extensions/browser-extension-popup-host.ts, src/main/browser/extensions/browser-extension-popup-size-watch.ts

// chrome.action（ツールバーのボタン）の main 側（P5）。ボタンの状態を持ち、workbench のツールバーに渡し、押されたら
// ポップアップ（拡張機能のページを出す枠の無い小さな窓）を出すか action.onClicked を出す。
//
//  - 状態は拡張機能を読み込んだセッションごと（Global と各ワークスペースのセッションは、それぞれ別の worker が
//    動くので、それぞれが自分のタブのボタンを決める）。ピン留めは場所（プロファイル）ごと（D2、台帳が持つ）
//  - ポップアップは BrowserWindow で、内蔵ブラウザのビュー（BrowserView）ではないので、エージェントの CDP の
//    ゲートウェイからは見えない。ボタンを押せるのは workbench の利用者だけ（エージェントは workbench を押せない）
//  - ポップアップは、それを出したウィンドウの一部として扱う（ポップアップから tabs.query({ active: true,
//    currentWindow: true }) で、ボタンを押したタブが見つかるように。Bitwarden はこれで入力先のページを探す）

import type { BrowserWindow, Session, WebContents } from 'electron';
import { promises as fs } from 'fs';
import { crc32, deflateSync } from 'zlib';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { join, normalize, sep } from '../../../../base/common/path.js';
import {
	IParadisActionDetails,
	IParadisRect,
	IParadisSize,
	PARADIS_ACTION_POPUP_MAX,
	ParadisActionIcon,
	ParadisBrowserExtensionActionState,
	paradisActionColorToCss,
	paradisActionIconFromPathSpec,
	paradisAnchorToScreen,
	paradisClampActionPopupSize,
	paradisIsAnchorRect,
	paradisParseActionColor,
	paradisPlaceActionPopup,
	paradisReadManifestActionDefaults,
} from '../common/paradisBrowserExtensionAction.js';
import { IParadisActionResult, IParadisBrowserExtensionToolbar, IParadisPopupRequest, IParadisToolbarAction, IParadisToolbarAnchor } from '../common/paradisBrowserExtensions.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, IParadisExtensionApiMethod, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import type { IParadisTabView, ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';

/** 読み込んだ拡張機能（Electron の Extension の、ここで使うところ）。 */
export interface IParadisLoadedExtension extends IParadisApiExtension {
	readonly name: string;
	/** 読み込んだフォルダ（Para Code の写し）。 */
	readonly path: string;
}

/** ボタンに要る、main のほかの部分（拡張機能の管理が渡す）。 */
export interface IParadisActionsEnvironment {
	/** 内蔵ブラウザのタブ（ビューの id から）。 */
	findView(viewId: string): IParadisTabView | undefined;
	/** そのタブのセッションに読み込んだ、利用者が入れた拡張機能と、その場所。拡張機能が入らないセッションなら undefined。 */
	sessionOf(contents: WebContents): { readonly session: ParadisApiSession; readonly place: string; readonly extensions: readonly IParadisLoadedExtension[] } | undefined;
	/** 場所でピン留めした拡張機能の id（ピン留めした順）。 */
	pinnedIn(place: string): readonly string[];
	setPinned(place: string, extensionId: string, pinned: boolean): Promise<void>;
	/** 台帳の名前（無ければ manifest の名前）。 */
	nameOf(extension: IParadisLoadedExtension): string;
	/** 利用者の操作をその拡張機能へ渡した（P5c、permissions）。 */
	noteUserGesture?(session: ParadisApiSession, extensionId: string): void;
	/** Para Code のウィンドウ（補助ウィンドウを含む。それ以外の id なら undefined）。 */
	windowById(windowId: number): BrowserWindow | undefined;
	/** ポップアップの窓を作る（まだ見せない）。 */
	createPopupWindow(parent: BrowserWindow, bounds: IParadisRect, session: Session): BrowserWindow;
	/** 画面の座標の四角がある画面の作業領域。 */
	workAreaFor(rect: IParadisRect): IParadisRect;
}

// 描き直しを束ねる長さ（バッジを頻繁に変える拡張機能でも、描き直しは少しにする）
const TOOLBAR_CHANGED_DELAY_MS = 50;
const POPUP_REQUEST_TIMEOUT_MS = 3_000;
/** ポップアップのボタンをもう一度押したとき、窓を閉じた（フォーカスを失った）直後なら「閉じる」とみなす長さ。 */
const TOGGLE_AFTER_BLUR_MS = 400;
/** ツールバーの絵は CSS の 16px で描く。32 で 2 倍の画面まで足りる。 */
const TOOLBAR_ICON_PIXELS = 32;
const MAX_ICON_BYTES = 512 * 1024;
const MAX_IMAGE_DATA_SIDE = 256;
const ICON_MIME_BY_SUFFIX: Readonly<Record<string, string>> = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};
/** ポップアップのページの大きさを測る world（ページからは見えない）。 */
const POPUP_SIZE_WORLD_ID = 1_999;

/** ImageData（詰め物が画素の並びにして送る）。 */
interface ISerializedImageData {
	readonly width: number;
	readonly height: number;
	readonly data: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const checksum = Buffer.alloc(4);
	checksum.writeUInt32BE(crc32(typed) >>> 0);
	return Buffer.concat([length, typed, checksum]);
}

/** RGBA の画素（ImageData の並び）を PNG にする。 */
export function paradisEncodeRgbaPng(width: number, height: number, rgba: ArrayLike<number>): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.writeUInt8(8, 8); // 8 bit
	header.writeUInt8(6, 9); // RGBA
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		// 各行の先頭はフィルタ 0（なし）
		for (let x = 0; x < stride; x++) {
			raw[y * (stride + 1) + 1 + x] = rgba[y * stride + x] ?? 0;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}

function isSerializedImageData(value: unknown): value is ISerializedImageData {
	if (!isRecord(value)) {
		return false;
	}
	const { width, height, data } = value;
	return typeof width === 'number' && typeof height === 'number' && Number.isInteger(width) && Number.isInteger(height)
		&& width > 0 && height > 0 && width <= MAX_IMAGE_DATA_SIDE && height <= MAX_IMAGE_DATA_SIDE
		&& Array.isArray(data) && data.length === width * height * 4;
}

/** ツールバーの大きさ以上で一番小さいもの。無ければ一番大きいもの。 */
function pickToolbarSize<T>(entries: readonly { readonly size: number; readonly value: T }[]): T | undefined {
	const sorted = [...entries].sort((a, b) => a.size - b.size);
	return (sorted.find(entry => entry.size >= TOOLBAR_ICON_PIXELS) ?? sorted.at(-1))?.value;
}

/** setIcon({ imageData }): ImageData 1 つか、大きさ → ImageData。ツールバーに合う大きさを PNG にする。 */
export function paradisActionIconFromImageData(input: unknown): ParadisActionIcon | null {
	const candidates = isSerializedImageData(input) ? [input] : isRecord(input) ? Object.values(input).filter(isSerializedImageData) : [];
	const chosen = pickToolbarSize(candidates.map(image => ({ size: image.width, value: image })));
	if (!chosen) {
		return null;
	}
	return { kind: 'data', dataUrl: `data:image/png;base64,${paradisEncodeRgbaPng(chosen.width, chosen.height, chosen.data).toString('base64')}` };
}

/** 拡張機能のフォルダの中のファイル（外を指すパスは undefined）。 */
function insideExtension(folder: string, relative: string): string | undefined {
	const cleaned = relative.replace(/^\/+/, '').split(/[?#]/)[0];
	let decoded: string;
	try {
		decoded = decodeURIComponent(cleaned);
	} catch {
		return undefined;
	}
	if (decoded.length === 0 || decoded.includes('\0')) {
		return undefined;
	}
	// 大文字と小文字を区別して比べる（写しのフォルダの中かを見るほかの所と同じ。区別しない比べ方だと、大文字と小文字だけが
	// 違う別のフォルダを中と取り違えうる）
	const root = normalize(folder);
	const absolute = normalize(join(root, decoded));
	return absolute.startsWith(root.endsWith(sep) ? root : root + sep) ? absolute : undefined;
}

/** ポップアップのページの大きさを、前に返したものと違うときに返す（ポップアップの world で動く）。 */
const WATCH_SIZE_SCRIPT = `(() => {
	const MAX_WIDTH = ${PARADIS_ACTION_POPUP_MAX.width};
	let state = window.__paradisPopupSize;
	const deliver = () => {
		if (!state.resolve || !state.pending) return;
		const resolve = state.resolve;
		const size = state.pending;
		state.resolve = null;
		state.pending = null;
		state.reported = size.width + 'x' + size.height;
		resolve(size);
	};
	if (!state) {
		state = window.__paradisPopupSize = { reported: '', pending: null, resolve: null, timer: 0 };
		const measureAt = (width) => {
			const sheet = new CSSStyleSheet();
			const quirks = document.compatMode === 'BackCompat';
			sheet.replaceSync('html{box-sizing:border-box!important;min-width:0!important;max-width:none!important;width:' + width + '!important}' + (quirks ? 'html,body{height:fit-content!important}' : ''));
			const sheets = document.adoptedStyleSheets;
			sheets.push(sheet);
			try {
				return document.documentElement.getBoundingClientRect();
			} finally {
				sheets.splice(sheets.indexOf(sheet), 1);
			}
		};
		const update = () => {
			state.timer = 0;
			if (!document.documentElement) return;
			const fit = measureAt('min-content');
			const width = Math.ceil(fit.width);
			const rect = width > MAX_WIDTH ? measureAt(MAX_WIDTH + 'px') : fit;
			const size = { width, height: Math.ceil(rect.height) };
			state.pending = size.width + 'x' + size.height === state.reported ? null : size;
			deliver();
		};
		const schedule = () => {
			if (!state.timer) state.timer = setTimeout(update, 50);
		};
		new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		const resizes = new ResizeObserver(schedule);
		resizes.observe(document.documentElement);
		if (document.body) resizes.observe(document.body);
		window.addEventListener('load', schedule);
		if (document.fonts) document.fonts.ready.then(schedule);
		update();
	}
	return new Promise((resolve) => {
		state.resolve = resolve;
		deliver();
	});
})()`;

function parsePopupSize(value: unknown): IParadisSize | undefined {
	return isRecord(value) && typeof value.width === 'number' && typeof value.height === 'number' && Number.isFinite(value.width) && Number.isFinite(value.height)
		? { width: value.width, height: value.height }
		: undefined;
}

/** 開いているポップアップ。 */
interface IOpenPopup {
	readonly window: BrowserWindow;
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly disposables: DisposableStore;
}

/** action.openPopup の待ち。 */
interface IPendingPopup {
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly settle: (error?: Error) => void;
}

/** 拡張機能自身のページか（URL の origin は chrome-extension: では "null" になるので、スキームと host で比べる）。 */
function isPageOf(rawUrl: string, extensionId: string): boolean {
	try {
		const url = new URL(rawUrl);
		return url.protocol === 'chrome-extension:' && url.host === extensionId;
	} catch {
		return false;
	}
}

const tabIdOk = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** `{ tabId?, ...rest }` の 1 つの引数（rest を確かめる）。 */
function detailsArg<T extends Record<string, unknown>>(check: (details: Record<string, unknown>) => boolean) {
	return (args: readonly unknown[]): [T] | undefined => args.length === 1 && isRecord(args[0]) && (args[0].tabId === undefined || tabIdOk(args[0].tabId)) && check(args[0]) ? [args[0] as T] : undefined;
}

/** 省略できる `{ tabId? }`。 */
function optionalDetails(args: readonly unknown[]): [{ readonly tabId?: number }] | undefined {
	if (args.length === 0) {
		return [{}];
	}
	return args.length === 1 && isRecord(args[0]) && (args[0].tabId === undefined || tabIdOk(args[0].tabId)) ? [args[0] as { readonly tabId?: number }] : undefined;
}

/** 省略できるタブの id（enable・disable・isEnabled）。 */
function optionalTabId(args: readonly unknown[]): [number | undefined] | undefined {
	return args.length === 0 ? [undefined] : args.length === 1 && tabIdOk(args[0]) ? [args[0]] : undefined;
}

export class ParadisBrowserExtensionActions implements IDisposable {

	private readonly _disposables = new DisposableStore();
	private readonly _states = new Map<ParadisApiSession, Map<string, ParadisBrowserExtensionActionState>>();
	private readonly _iconCache = new Map<string, Promise<string | undefined>>();
	private readonly _onDidChangeToolbar = this._disposables.add(new Emitter<void>());
	readonly onDidChangeToolbar: Event<void> = this._onDidChangeToolbar.event;
	private readonly _onDidRequestPopup = this._disposables.add(new Emitter<IParadisPopupRequest>());
	readonly onDidRequestPopup: Event<IParadisPopupRequest> = this._onDidRequestPopup.event;
	private _changedTimer: ReturnType<typeof setTimeout> | undefined;
	private _popup: IOpenPopup | undefined;
	/** サイドパネル（P9d）。ボタンで開く設定ならポップアップより先に開く・閉じる。 */
	private _sidePanel: { toggle(view: IParadisTabView, session: ParadisApiSession, place: string, extension: IParadisLoadedExtension): boolean; has(view: IParadisTabView, session: ParadisApiSession, extension: IParadisLoadedExtension): boolean } | undefined;
	private _lastBlurClose: { readonly session: ParadisApiSession; readonly extensionId: string; readonly at: number } | undefined;
	private readonly _pendingPopups = new Set<IPendingPopup>();
	private _nextRequestId = 1;

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _tabs: ParadisBrowserExtensionTabs,
		private readonly _environment: IParadisActionsEnvironment,
		private readonly _logService: { warn(message: string, ...args: unknown[]): void },
	) {
		const namespace = { methods: this._methods(), events: ['onClicked', 'onUserSettingsChanged'] };
		_host.registerNamespace('action', namespace);
		_host.registerNamespace('browserAction', namespace);
		this._disposables.add(_tabs.onDidResetTab(tabId => {
			let changed = false;
			for (const byExtension of this._states.values()) {
				for (const state of byExtension.values()) {
					changed = state.forgetTab(tabId) || changed;
				}
			}
			if (changed) {
				this.notifyChanged();
			}
		}));
	}

	dispose(): void {
		if (this._changedTimer !== undefined) {
			clearTimeout(this._changedTimer);
		}
		this._closePopup();
		for (const pending of [...this._pendingPopups]) {
			pending.settle(new ParadisExtensionApiError('Para Code is closing'));
		}
		this._disposables.dispose();
	}

	/** ツールバーが変わった（描き直しは束ねて知らせる）。 */
	notifyChanged(): void {
		this._changedTimer ??= setTimeout(() => {
			this._changedTimer = undefined;
			this._onDidChangeToolbar.fire();
		}, TOOLBAR_CHANGED_DELAY_MS);
	}

	/** 拡張機能をセッションから外した: ボタンの状態を忘れ、そのポップアップを閉じる。 */
	forgetExtension(session: ParadisApiSession, extensionId: string, path?: string): void {
		this._states.get(session)?.delete(extensionId);
		if (path !== undefined) {
			for (const key of [...this._iconCache.keys()]) {
				if (key.startsWith(`${path}\0`)) {
					this._iconCache.delete(key);
				}
			}
		}
		if (this._popup && this._popup.session === session && this._popup.extensionId === extensionId) {
			this._closePopup();
		}
		this.notifyChanged();
	}

	private _state(session: ParadisApiSession, extension: IParadisApiExtension): ParadisBrowserExtensionActionState {
		let byExtension = this._states.get(session);
		if (!byExtension) {
			byExtension = new Map();
			this._states.set(session, byExtension);
		}
		let state = byExtension.get(extension.id);
		if (!state) {
			// Chromium は読み込むときに manifest の __MSG_ を訳す
			state = new ParadisBrowserExtensionActionState(paradisReadManifestActionDefaults(extension.manifest, typeof extension.manifest.name === 'string' ? extension.manifest.name : extension.id));
			byExtension.set(extension.id, state);
		}
		return state;
	}

	// --- chrome.action ---

	/** タブの id は、呼び出し元が見てよいタブだけ（省略は全体の値）。 */
	private _scope(caller: IParadisExtensionApiCaller, tabId: number | undefined): number | undefined {
		if (tabId !== undefined) {
			this._tabs.assertTab(caller, tabId);
		}
		return tabId;
	}

	private _set<Key extends keyof IParadisActionDetails>(caller: IParadisExtensionApiCaller, key: Key, value: IParadisActionDetails[Key] | null, tabId: number | undefined): void {
		this._state(caller.session, caller.extension).set(key, value, this._scope(caller, tabId));
		this.notifyChanged();
	}

	private _get(caller: IParadisExtensionApiCaller, tabId: number | undefined): IParadisActionDetails {
		return this._state(caller.session, caller.extension).get(this._scope(caller, tabId));
	}

	private _requireColor(input: unknown) {
		const color = paradisParseActionColor(input);
		if (!color) {
			throw new ParadisExtensionApiError('The color specification could not be parsed.');
		}
		return color;
	}

	/** setPopup は拡張機能の中のパス（または自分の URL）。 */
	private _popupPath(caller: IParadisExtensionApiCaller, popup: string): string {
		if (popup === '') {
			return '';
		}
		const origin = `chrome-extension://${caller.extension.id}/`;
		const url = new URL(popup, origin);
		if (!url.href.startsWith(origin)) {
			throw new ParadisExtensionApiError('The popup must be a page of this extension');
		}
		return url.pathname.slice(1) + url.search + url.hash;
	}

	/** setIcon の path（詰め物が呼んだスクリプトから見た URL にしてある）を、拡張機能の中のパスにする。 */
	private _iconPaths(caller: IParadisExtensionApiCaller, path: unknown): unknown {
		const origin = `chrome-extension://${caller.extension.id}/`;
		const toPath = (value: unknown) => {
			if (typeof value !== 'string') {
				return value;
			}
			try {
				const url = new URL(value, origin);
				return url.href.startsWith(origin) ? decodeURIComponent(url.pathname.slice(1)) : value;
			} catch {
				return value;
			}
		};
		return isRecord(path) ? Object.fromEntries(Object.entries(path).map(([size, value]) => [size, toPath(value)])) : toPath(path);
	}

	private _methods(): Record<string, IParadisExtensionApiMethod> {
		const string = (key: string) => (details: Record<string, unknown>) => typeof details[key] === 'string';
		const color = (details: Record<string, unknown>) => typeof details.color === 'string' || Array.isArray(details.color);
		return {
			setTitle: paradisDefineExtensionMethod(detailsArg<{ title: string; tabId?: number }>(string('title')), (caller, { title, tabId }) => this._set(caller, 'title', title.slice(0, 1_000), tabId)),
			getTitle: paradisDefineExtensionMethod(optionalDetails, (caller, { tabId }) => this._get(caller, tabId).title),
			setIcon: paradisDefineExtensionMethod(detailsArg<{ imageData?: unknown; path?: unknown; tabId?: number }>(() => true), (caller, { imageData, path, tabId }) => {
				const icon = imageData !== undefined ? paradisActionIconFromImageData(imageData) : paradisActionIconFromPathSpec(this._iconPaths(caller, path));
				if (!icon) {
					throw new ParadisExtensionApiError('Either path or imageData must be specified.');
				}
				this._set(caller, 'icon', icon, tabId);
			}),
			setPopup: paradisDefineExtensionMethod(detailsArg<{ popup: string; tabId?: number }>(string('popup')), (caller, { popup, tabId }) => this._set(caller, 'popup', this._popupPath(caller, popup), tabId)),
			getPopup: paradisDefineExtensionMethod(optionalDetails, (caller, { tabId }) => {
				const popup = this._get(caller, tabId).popup;
				return popup === '' ? '' : `chrome-extension://${caller.extension.id}/${popup}`;
			}),
			setBadgeText: paradisDefineExtensionMethod(detailsArg<{ text?: string | null; tabId?: number }>(details => details.text === undefined || details.text === null || typeof details.text === 'string'), (caller, { text, tabId }) =>
				// Chrome: タブの値は null・undefined で消える。'' は「空にする」という値
				this._set(caller, 'badgeText', typeof text === 'string' ? text.slice(0, 100) : (tabId === undefined ? '' : null), tabId)),
			getBadgeText: paradisDefineExtensionMethod(optionalDetails, (caller, { tabId }) => this._get(caller, tabId).badgeText),
			setBadgeBackgroundColor: paradisDefineExtensionMethod(detailsArg<{ color: unknown; tabId?: number }>(color), (caller, { color: value, tabId }) => this._set(caller, 'badgeBackgroundColor', this._requireColor(value), tabId)),
			getBadgeBackgroundColor: paradisDefineExtensionMethod(optionalDetails, (caller, { tabId }) => this._get(caller, tabId).badgeBackgroundColor ?? [0, 0, 0, 0]),
			setBadgeTextColor: paradisDefineExtensionMethod(detailsArg<{ color: unknown; tabId?: number }>(color), (caller, { color: value, tabId }) => this._set(caller, 'badgeTextColor', this._requireColor(value), tabId)),
			getBadgeTextColor: paradisDefineExtensionMethod(optionalDetails, (caller, { tabId }) => this._get(caller, tabId).badgeTextColor ?? [0, 0, 0, 0]),
			enable: paradisDefineExtensionMethod(optionalTabId, (caller, tabId) => this._set(caller, 'enabled', true, tabId)),
			disable: paradisDefineExtensionMethod(optionalTabId, (caller, tabId) => this._set(caller, 'enabled', false, tabId)),
			isEnabled: paradisDefineExtensionMethod(optionalTabId, (caller, tabId) => this._get(caller, tabId).enabled),
			getUserSettings: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => ({ isOnToolbar: this._environment.pinnedIn(caller.place).includes(caller.extension.id) })),
			openPopup: paradisDefineExtensionMethod(args => args.length === 0 || (args.length === 1 && (args[0] === undefined || isRecord(args[0]))) ? [] as [] : undefined, caller => this._requestPopup(caller)),
		};
	}

	// --- ツールバー ---

	/** 管理画面に出すアイコン（manifest の icons、無ければ action の default_icon）を data URL で読む。 */
	manifestIconDataUrl(folder: string, manifest: Record<string, unknown> | undefined): Promise<string | undefined> {
		const action = manifest?.action ?? manifest?.browser_action;
		const actionIcon = action !== null && typeof action === 'object' ? (action as Record<string, unknown>).default_icon : undefined;
		return this._iconDataUrl(folder, paradisActionIconFromPathSpec(manifest?.icons) ?? paradisActionIconFromPathSpec(actionIcon));
	}

	private _iconDataUrl(folder: string, icon: ParadisActionIcon | null): Promise<string | undefined> {
		if (!icon) {
			return Promise.resolve(undefined);
		}
		if (icon.kind === 'data') {
			return Promise.resolve(icon.dataUrl);
		}
		const relative = pickToolbarSize(Object.entries(icon.paths).map(([size, value]) => ({ size: Number.parseInt(size, 10) || 0, value })));
		if (relative === undefined) {
			return Promise.resolve(undefined);
		}
		const key = `${folder}\0${relative}`;
		let cached = this._iconCache.get(key);
		if (!cached) {
			cached = (async () => {
				const absolute = insideExtension(folder, relative);
				const mime = ICON_MIME_BY_SUFFIX[absolute?.split('.').at(-1)?.toLowerCase() ?? ''];
				if (!absolute || !mime) {
					return undefined;
				}
				try {
					if ((await fs.stat(absolute)).size > MAX_ICON_BYTES) {
						return undefined;
					}
					return `data:${mime};base64,${(await fs.readFile(absolute)).toString('base64')}`;
				} catch {
					return undefined;
				}
			})();
			this._iconCache.set(key, cached);
		}
		return cached;
	}

	private _toolbarView(viewId: string): IParadisTabView | undefined {
		const view = typeof viewId === 'string' ? this._environment.findView(viewId) : undefined;
		// エージェントのタブには拡張機能が入らない（別のセッション）が、念のため見せない
		return view && !view.webContents.isDestroyed() && !view.isAgentTab() ? view : undefined;
	}

	/** サイドパネルをつなぐ（拡張機能の管理が、サイドパネルを作った後に呼ぶ）。 */
	setSidePanel(sidePanel: NonNullable<ParadisBrowserExtensionActions['_sidePanel']>): void {
		this._sidePanel = sidePanel;
	}

	async getToolbar(viewId: string): Promise<IParadisBrowserExtensionToolbar | undefined> {
		const view = this._toolbarView(viewId);
		const info = view ? this._environment.sessionOf(view.webContents) : undefined;
		if (!view || !info) {
			return undefined;
		}
		const pinOrder = this._environment.pinnedIn(info.place);
		const tabId = view.webContents.id;
		const actions = await Promise.all(info.extensions.map(async (extension): Promise<IParadisToolbarAction> => {
			const details = this._state(info.session, extension).get(tabId);
			const manifest = extension.manifest as { options_ui?: { page?: unknown }; options_page?: unknown };
			const badgeBackgroundColor = paradisActionColorToCss(details.badgeBackgroundColor);
			const badgeTextColor = paradisActionColorToCss(details.badgeTextColor);
			const iconDataUrl = await this._iconDataUrl(extension.path, details.icon);
			return {
				extensionId: extension.id,
				name: this._environment.nameOf(extension),
				title: details.title,
				...(iconDataUrl !== undefined ? { iconDataUrl } : {}),
				badgeText: details.badgeText,
				...(badgeBackgroundColor !== undefined ? { badgeBackgroundColor } : {}),
				...(badgeTextColor !== undefined ? { badgeTextColor } : {}),
				enabled: details.enabled,
				hasPopup: details.popup !== '',
				pinned: pinOrder.includes(extension.id),
				hasOptionsPage: typeof (manifest.options_ui?.page ?? manifest.options_page) === 'string',
				hasSidePanel: this._sidePanel?.has(view, info.session, extension) === true,
			};
		}));
		const rank = (action: IParadisToolbarAction) => action.pinned ? pinOrder.indexOf(action.extensionId) : Number.MAX_SAFE_INTEGER;
		actions.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
		return { place: info.place, actions };
	}

	async setPinned(viewId: string, extensionId: string, pinned: boolean): Promise<void> {
		const view = this._toolbarView(viewId);
		const info = view ? this._environment.sessionOf(view.webContents) : undefined;
		if (!info || typeof pinned !== 'boolean' || !info.extensions.some(extension => extension.id === extensionId)) {
			return;
		}
		await this._environment.setPinned(info.place, extensionId, pinned);
		// Chrome の action.onUserSettingsChanged（このタブのセッションの拡張機能へ。同じ場所のほかのセッションは
		// 次に getUserSettings を呼んだときに分かる）
		this._emitAction(info.session, extensionId, 'onUserSettingsChanged', [{ isOnToolbar: pinned }]);
		this.notifyChanged();
	}

	async openOptions(viewId: string, extensionId: string): Promise<IParadisActionResult> {
		const resolved = this._resolve(viewId, extensionId);
		if (!resolved) {
			return { ok: false, error: 'This extension is not on for this tab' };
		}
		const manifest = resolved.extension.manifest as { options_ui?: { page?: unknown }; options_page?: unknown };
		const page = manifest.options_ui?.page ?? manifest.options_page;
		if (typeof page !== 'string' || page.length === 0) {
			return { ok: false, error: 'This extension has no options page' };
		}
		try {
			await this._tabs.openTabFor(this._callerFor(resolved), page.replace(/^\/+/, ''));
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private _resolve(viewId: string, extensionId: string): { readonly view: IParadisTabView; readonly session: ParadisApiSession; readonly place: string; readonly extension: IParadisLoadedExtension } | undefined {
		const view = this._toolbarView(viewId);
		const info = view ? this._environment.sessionOf(view.webContents) : undefined;
		const extension = info?.extensions.find(candidate => candidate.id === extensionId);
		return view && info && extension ? { view, session: info.session, place: info.place, extension } : undefined;
	}

	/** main の中から拡張機能のページの代わりに API を使うときの呼び出し元。 */
	private _callerFor(resolved: { readonly session: ParadisApiSession; readonly place: string; readonly extension: IParadisLoadedExtension }): IParadisExtensionApiCaller {
		return { extension: resolved.extension, session: resolved.session, place: resolved.place, connection: 'page-paracode-action', fromWorker: false };
	}

	private _emitAction(session: ParadisApiSession, extensionId: string, event: string, args: readonly unknown[]): void {
		// 拡張機能はどちらかの名前で受ける（MV3 は action、MV2 は browserAction）
		for (const namespace of ['action', 'browserAction']) {
			this._host.emit({ session, extensionId }, namespace, event, args);
		}
	}

	/**
	 * ボタンを押した。ポップアップを出す（もう一度押すと閉じる）か、ポップアップが無ければ action.onClicked を、
	 * そのタブを付けて出す。`popupOnly` は action.openPopup の答え（ポップアップが無ければ失敗）。
	 */
	async activateAction(viewId: string, extensionId: string, anchor: IParadisToolbarAnchor, popupOnly: boolean): Promise<IParadisActionResult> {
		try {
			const resolved = this._resolve(viewId, extensionId);
			if (!resolved || !paradisIsAnchorRect(anchor) || typeof popupOnly !== 'boolean') {
				throw new ParadisExtensionApiError('This extension is not on for this tab');
			}
			const { view, session, extension } = resolved;
			// ボタンはそのタブを出しているウィンドウにある。違うウィンドウの位置は受け取らない
			const window = anchor.windowId === view.windowId ? this._environment.windowById(anchor.windowId) : undefined;
			if (!window) {
				throw new ParadisExtensionApiError('Para Code has no window to show the popup in');
			}
			// 押したタブを、そのウィンドウの前のタブにする（ポップアップの tabs.query({ active }) が見つけられるように）
			this._tabs.noteUserActivatedTab(view);
			const tabId = view.webContents.id;
			const details = this._state(session, extension).get(tabId);
			if (!popupOnly && this._consumeToggle(session, extensionId)) {
				return { ok: true };
			}
			if (!details.enabled && !popupOnly) {
				return { ok: true };
			}
			// ボタンでサイドパネルを開く設定なら、ポップアップ・onClicked より先（Chromium と同じく activeTab は与えない）
			if (!popupOnly && this._sidePanel?.toggle(view, session, resolved.place, extension)) {
				this._environment.noteUserGesture?.(session, extension.id);
				return { ok: true };
			}
			if (!popupOnly) {
				// activeTab: 利用者が押したので、そのタブの URL とタイトルを見せる
				this._tabs.grantActiveTab(extension, tabId);
				// 利用者の操作（permissions.request・management.setEnabled などを、この後の少しの間だけ許す）
				this._environment.noteUserGesture?.(session, extension.id);
			}
			if (details.popup !== '') {
				this._openPopup(resolved, details.popup, window, anchor);
				this._settlePending(session, extensionId);
				return { ok: true };
			}
			if (popupOnly) {
				throw new ParadisExtensionApiError('This extension has no popup');
			}
			const tab = this._tabs.describeTab(extension, view.webContents.session, tabId);
			// worker が受け手をまだ登録していない（止まっている・一度も評価に成功していない）ときも、起こして溜めて届ける
			const clickedNamespace = extension.manifest.manifest_version === 2 ? 'browserAction' : 'action';
			this._host.emitWakingWorker({ session, extensionId }, clickedNamespace, 'onClicked', tab ? [tab] : []);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	// --- ポップアップ ---

	/** ポップアップのボタンをもう一度押した: 閉じるだけにする（開いていた、またはフォーカスを失って閉じた直後）。 */
	private _consumeToggle(session: ParadisApiSession, extensionId: string): boolean {
		const popup = this._popup;
		if (popup && !popup.window.isDestroyed() && popup.session === session && popup.extensionId === extensionId) {
			this._closePopup();
			return true;
		}
		const recent = this._lastBlurClose;
		this._lastBlurClose = undefined;
		return recent !== undefined && recent.session === session && recent.extensionId === extensionId && Date.now() - recent.at < TOGGLE_AFTER_BLUR_MS;
	}

	private _closePopup(): void {
		const popup = this._popup;
		this._popup = undefined;
		if (popup) {
			popup.disposables.dispose();
			if (!popup.window.isDestroyed()) {
				popup.window.close();
			}
		}
	}

	private _openPopup(resolved: { readonly view: IParadisTabView; readonly session: ParadisApiSession; readonly place: string; readonly extension: IParadisLoadedExtension }, popupPath: string, parent: BrowserWindow, anchorInWindow: IParadisRect): void {
		const origin = `chrome-extension://${resolved.extension.id}`;
		const url = new URL(popupPath.replace(/^\/+/, ''), `${origin}/`);
		// URL の origin は chrome-extension: では "null" になる（標準でないスキーム）。スキームと host で比べる
		if (!isPageOf(url.href, resolved.extension.id)) {
			throw new ParadisExtensionApiError('The popup must be a page of the extension');
		}
		this._closePopup();
		const anchor = paradisAnchorToScreen(anchorInWindow, parent.getContentBounds(), parent.webContents.getZoomFactor());
		const workArea = this._environment.workAreaFor(anchor);
		// 一番大きな大きさで作る（ページは作られたときの大きさで割り付けるので、Chrome のポップアップと同じく
		// 大きく作ってから中身に合わせて縮める。Bitwarden は innerHeight から自分の大きさを決める）
		const initial = paradisPlaceActionPopup(anchor, PARADIS_ACTION_POPUP_MAX, workArea);
		const window = this._environment.createPopupWindow(parent, initial, resolved.view.webContents.session as Session);
		const disposables = new DisposableStore();
		const popup: IOpenPopup = { window, session: resolved.session, extensionId: resolved.extension.id, disposables };
		this._popup = popup;
		// ポップアップは、拡張機能に見せるタブの窓の一部（tabs.query の currentWindow がボタンを押したタブの窓になる）
		disposables.add(this._tabs.treatWindowAsPartOf(window.id, resolved.view.windowId));
		const contents = window.webContents;
		// 閉じるときに「このページを離れますか」で止めない
		contents.on('will-prevent-unload', event => event.preventDefault());
		const watch = disposables.add(new MutableDisposable<IDisposable>());
		let presented = false;
		const watchSize = (): Promise<void> => {
			let current = true;
			watch.value = toDisposable(() => current = false);
			return new Promise<void>(firstApplied => {
				const poll = async () => {
					for (; ;) {
						const measured: unknown = await contents.executeJavaScriptInIsolatedWorld(POPUP_SIZE_WORLD_ID, [{ code: WATCH_SIZE_SCRIPT }]).catch(() => undefined);
						const size = parsePopupSize(measured);
						if (!size || window.isDestroyed() || !current) {
							break;
						}
						window.setBounds(paradisPlaceActionPopup(anchor, paradisClampActionPopupSize(size), workArea));
						firstApplied();
					}
					firstApplied();
				};
				void poll();
			});
		};
		contents.on('did-navigate', () => {
			if (presented) {
				void watchSize();
			}
		});
		contents.on('before-input-event', (event, input) => {
			if (input.type === 'keyDown' && input.key === 'Escape') {
				event.preventDefault();
				if (this._popup === popup) {
					this._closePopup();
				}
			}
		});
		// target=_blank のリンクは、そのタブと同じ場所の新しいタブで開く
		contents.setWindowOpenHandler(({ url: target }) => {
			void this._tabs.openTabFor(this._callerFor(resolved), target).catch(error => this._logService.warn('[paradis] a browser extension popup could not open a tab', error));
			return { action: 'deny' };
		});
		// 拡張機能自身のページの間だけ移れる（アドレスバーの無い窓でウェブのページを開かせない）
		const stayOnExtension = (event: { preventDefault(): void }, target: string) => {
			if (!isPageOf(target, resolved.extension.id)) {
				event.preventDefault();
			}
		};
		contents.on('will-navigate', (event, target) => stayOnExtension(event, target));
		contents.on('will-redirect', (event, target) => stayOnExtension(event, target));
		window.on('blur', () => {
			if (this._popup === popup) {
				this._lastBlurClose = { session: popup.session, extensionId: popup.extensionId, at: Date.now() };
				this._closePopup();
			}
		});
		// Para Code のウィンドウに戻った・押したタブが隠れた・閉じたら閉じる（フォーカスを渡せない環境でも残らないように）
		const closeOnParentFocus = () => {
			if (this._popup === popup) {
				this._closePopup();
			}
		};
		parent.on('focus', closeOnParentFocus);
		disposables.add(toDisposable(() => {
			if (!parent.isDestroyed()) {
				parent.removeListener('focus', closeOnParentFocus);
			}
		}));
		disposables.add(resolved.view.onDidChangeVisibility(visible => {
			if (!visible) {
				closeOnParentFocus();
			}
		}));
		disposables.add(resolved.view.onDidClose(closeOnParentFocus));
		window.once('closed', () => {
			disposables.dispose();
			if (this._popup === popup) {
				this._popup = undefined;
			}
		});
		window.once('ready-to-show', () => {
			void watchSize().then(() => {
				if (!window.isDestroyed() && this._popup === popup) {
					presented = true;
					window.show();
					window.focus();
				}
			});
		});
		window.loadURL(url.href).catch((error: unknown) => this._logService.warn('[paradis] a browser extension popup failed to load', error));
	}

	private _settlePending(session: ParadisApiSession, extensionId: string): void {
		for (const pending of [...this._pendingPopups]) {
			if (pending.session === session && pending.extensionId === extensionId) {
				pending.settle();
			}
		}
	}

	/** action.openPopup: 今のウィンドウの前のタブのボタンから出す（ボタンの位置は workbench が知っている）。 */
	private _requestPopup(caller: IParadisExtensionApiCaller): Promise<void> {
		const view = this._tabs.activeEditorTab(caller);
		if (!view) {
			return Promise.reject(new ParadisExtensionApiError('No active tab to show the popup on'));
		}
		const popup = this._popup;
		if (popup && !popup.window.isDestroyed() && popup.session === caller.session && popup.extensionId === caller.extension.id) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => pending.settle(new ParadisExtensionApiError('Could not show the popup')), POPUP_REQUEST_TIMEOUT_MS);
			const pending: IPendingPopup = {
				session: caller.session,
				extensionId: caller.extension.id,
				settle: error => {
					clearTimeout(timer);
					this._pendingPopups.delete(pending);
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				},
			};
			this._pendingPopups.add(pending);
			this._onDidRequestPopup.fire({ requestId: this._nextRequestId++, viewId: view.id, extensionId: caller.extension.id });
		});
	}
}
