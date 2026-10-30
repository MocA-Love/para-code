/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// chrome.desktopCapture・chrome.tabCapture（P9e、Loom）。Electron に無いので、拡張機能のページの getDisplayMedia を、
// セッションの setDisplayMediaRequestHandler で決めた 1 つの源（内蔵ブラウザのタブ・ほかのアプリの窓）に当てる。
//  - 拡張機能に渡すのは、ここで作った使い捨ての印（stream id）だけ。desktopCapturer の生の id は渡さない（生の id は、
//    同じセッションのページが getUserMedia の chromeMediaSource: 'desktop' に当てるだけで画面を撮れてしまうため）
//  - 詰め物（../common/paradisBrowserExtensionShim.ts）が、印の付いた getUserMedia を「印を構える → getDisplayMedia」に
//    置き換える。構えた印は、その拡張機能のページからの次の 1 回の getDisplayMedia にだけ、短い期限で当てる。当たらなければ
//    断る（画面全体には落とさない。browserMirror の予約と同じ考え）
//  - 撮ってよいタブは paradisExtensionMayUseTab（エージェントのタブ・共有中のタブは撮らない）。撮っている途中にそうなった・
//    閉じたら止める
//  - desktopCapture の窓の候補から Para Code の窓を外す。画面全体は出さない（Para Code の窓が必ず写る）。窓を出すのは、
//    OS の画面収録の許しを OS が確かめる macOS だけ（paradisCaptureWindowsOffered。利用者に聞いている）
//  - 何を撮るかは、利用者がダイアログで選ぶ（tabCapture は、Chromium と同じく、そのタブで拡張機能のボタンを押したときだけ）

import { randomUUID } from 'crypto';
import type { DesktopCapturerSource, Session, WebContents, WebFrameMain } from 'electron';
import { DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { paradisSetDisplayCaptureGate } from '../../../../platform/browserView/common/paradisDisplayCaptureGate.js';
import { paradisOnDidChangeExtensionPageHold } from '../../../../platform/browserView/common/paradisExtensionPageHold.js';
import { PARADIS_CAPTURE_STREAM_ID_PREFIX, PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, PARADIS_SHIM_TAB_CAPTURE_NAMESPACE } from '../common/paradisBrowserExtensionShim.js';
import { IParadisApiExtension, IParadisExtensionApiCaller, ParadisApiSession, ParadisExtensionApiError, ParadisExtensionApiHost, paradisDefineExtensionMethod } from './paradisBrowserExtensionApiHost.js';
import { IParadisCaptureTab, paradisExtensionMayUseTab, type ParadisBrowserExtensionTabs } from './paradisBrowserExtensionTabs.js';

/** chooseDesktopMedia・getMediaStreamId の印を構えるまでの期限（Chromium の印も数秒で切れる）。 */
const RESERVATION_TTL_MS = 30_000;
/** 印を構えてから getDisplayMedia が届くまでの期限。 */
const ARM_TTL_MS = 5_000;
/** ダイアログに並べる候補の上限（ボタンにするため）。 */
const MAX_CHOICES = 8;

const SOURCE_TYPES = new Set(['screen', 'window', 'tab', 'audio']);

/**
 * desktopCapture でほかのアプリの窓を候補に出すか。OS が画面収録の許しを確かめ、Para Code の窓を候補から外せる
 * macOS だけ。Windows・Linux（X11）には OS の確かめが無く、Linux（Wayland）は OS の選び手が Para Code の窓も出すため
 * 出さない（利用者に聞いている。答えで変わりうる。決まりはここ 1 か所）。
 */
export function paradisCaptureWindowsOffered(platform: string): boolean {
	return platform === 'darwin';
}

/** 撮る源。 */
type CaptureTarget =
	| { readonly kind: 'tab'; readonly tabId: number; readonly contents: WebContents }
	| { readonly kind: 'window'; readonly source: Pick<DesktopCapturerSource, 'id' | 'name'> };

interface IReservation {
	readonly token: string;
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly target: CaptureTarget;
	/** 音を撮ってよいか（タブの音。窓の音は撮らない）。 */
	readonly audio: boolean;
	readonly expiresAt: number;
	armedUntil?: number;
}

interface IActiveCapture {
	readonly token: string;
	readonly session: ParadisApiSession;
	readonly extensionId: string;
	readonly target: CaptureTarget;
	readonly disposables: DisposableStore;
}

/** ダイアログに出す候補。 */
export interface IParadisCaptureChoice {
	readonly label: string;
}

/** 管理から渡すもの（テストでは偽物）。 */
export interface IParadisCaptureEnvironment {
	readonly platform: string;
	/** ほかのアプリの窓（desktopCapturer.getSources。macOS では OS の画面収録の許しを確かめる）。 */
	getWindowSources(): Promise<readonly Pick<DesktopCapturerSource, 'id' | 'name'>[]>;
	/** Para Code の窓の media source id（`window:<id>:<n>`）。 */
	ownWindowSourceIds(): readonly string[];
	/** OS の画面収録の許し（macOS の systemPreferences.getMediaAccessStatus('screen')。ほかの OS では 'granted'）。 */
	screenAccess(): string;
	/** 撮るものを選ぶダイアログ。選んだ候補の番号（取り消しなら undefined）。 */
	pick(prompt: { readonly extensionName: string; readonly choices: readonly IParadisCaptureChoice[]; readonly note?: string }): Promise<number | undefined>;
	nameOf(extension: IParadisApiExtension): string;
	now?(): number;
}

/** ダイアログのボタンの文字の上限（長い URL でダイアログが画面より広くならないように）。 */
const MAX_LABEL_CHARS = 60;

function shorten(text: string): string {
	return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}\u2026` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 拡張機能のページのフレームなら、その拡張機能の id。 */
function extensionIdOfFrame(frame: Pick<WebFrameMain, 'url'> | null | undefined): string | undefined {
	const match = /^chrome-extension:\/\/(?<id>[a-p]{32})\//.exec(frame?.url ?? '');
	return match?.groups?.id;
}

export class ParadisBrowserExtensionCapture implements IDisposable {

	private readonly _disposables = new DisposableStore();
	private readonly _reservations = new Map<string, IReservation>();
	private readonly _active = new Map<string, IActiveCapture>();
	/** 選んでいる途中の chooseDesktopMedia（拡張機能 → 頼みの番号）。cancelChooseDesktopMedia で答えを捨てる。 */
	private readonly _cancelled = new Set<string>();

	constructor(
		private readonly _host: ParadisExtensionApiHost,
		private readonly _tabs: ParadisBrowserExtensionTabs,
		private readonly _environment: IParadisCaptureEnvironment,
	) {
		_host.registerNamespace(PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE, {
			permission: 'desktopCapture',
			methods: {
				choose: paradisDefineExtensionMethod(
					args => args.length === 3 && typeof args[0] === 'number' && Array.isArray(args[1]) && args[1].every(value => typeof value === 'string') && (args[2] === undefined || args[2] === null || isRecord(args[2])) ? [args[0], args[1] as string[], args[2] ?? undefined] as [number, string[], Record<string, unknown> | undefined] : undefined,
					(caller, requestId, sources, targetTab) => this._chooseDesktopMedia(caller, requestId, sources, targetTab)),
				cancel: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'number' ? [args[0]] as [number] : undefined, (caller, requestId) => {
					this._cancelled.add(`${caller.extension.id}:${caller.connection}:${requestId}`);
				}),
				arm: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'string' ? [args[0]] as [string] : undefined, (caller, token) => this._arm(caller, token)),
				release: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'string' ? [args[0]] as [string] : undefined, (caller, token) => this._release(caller, token)),
			},
			events: ['onStop'],
		});
		_host.registerNamespace(PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, {
			permission: 'tabCapture',
			methods: {
				getMediaStreamId: paradisDefineExtensionMethod(args => args.length === 1 && (args[0] === undefined || args[0] === null || isRecord(args[0])) ? [args[0] ?? undefined] as [Record<string, unknown> | undefined] : undefined, (caller, options) => this._getMediaStreamId(caller, options)),
				capture: paradisDefineExtensionMethod(args => args.length === 1 && isRecord(args[0]) ? [args[0]] as [Record<string, unknown>] : undefined, (caller, options) => this._capture(caller, options)),
				getCapturedTabs: paradisDefineExtensionMethod(args => args.length === 0 ? [] as [] : undefined, caller => this._capturedTabs(caller)),
				arm: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'string' ? [args[0]] as [string] : undefined, (caller, token) => this._arm(caller, token)),
				release: paradisDefineExtensionMethod(args => args.length === 1 && typeof args[0] === 'string' ? [args[0]] as [string] : undefined, (caller, token) => this._release(caller, token)),
			},
			events: ['onStatusChanged', 'onStop'],
		});
		this._disposables.add(_host.onDidCloseContext((session, extensionId, connection) => {
			if (connection === undefined) {
				// 拡張機能を外した・無効にした: 印を捨てて、撮っているものを止める
				for (const [token, reservation] of [...this._reservations]) {
					if (reservation.session === session && reservation.extensionId === extensionId) {
						this._reservations.delete(token);
					}
				}
				for (const capture of [...this._active.values()]) {
					if (capture.session === session && capture.extensionId === extensionId) {
						this._stop(capture);
					}
				}
			}
		}));
		// 印を構えた拡張機能のページの getDisplayMedia だけを、内蔵ブラウザのセッションの権限に通させる
		paradisSetDisplayCaptureGate(url => this._isArmedFor(extensionIdOfFrame({ url })));
		this._disposables.add(toDisposable(() => paradisSetDisplayCaptureGate(undefined)));
		// 撮っているタブがエージェントのタブ・共有中のタブになった: 止める
		this._disposables.add(_tabs.onDidBecomeAgentTab(contents => this._stopForContents(contents)));
		this._disposables.add(paradisOnDidChangeExtensionPageHold((contents, isHeld) => {
			if (isHeld) {
				this._stopForContents(contents);
			}
		}));
	}

	/**
	 * セッションの getDisplayMedia の受け手を立てる（拡張機能を入れる内蔵ブラウザのセッションだけ）。印の当たらない要求は断る
	 * （受け手を立てる前も、内蔵ブラウザのページの getDisplayMedia は使えなかった）。
	 */
	attachSession(apiSession: ParadisApiSession, electronSession: Partial<Pick<Session, 'setDisplayMediaRequestHandler'>>): IDisposable {
		if (typeof electronSession.setDisplayMediaRequestHandler !== 'function') {
			return toDisposable(() => { });
		}
		electronSession.setDisplayMediaRequestHandler((request, callback) => {
			try {
				callback(this.resolveDisplayMedia(apiSession, request));
			} catch {
				// フレームが先に消えた
				try {
					callback({});
				} catch {
					// もう答えられない
				}
			}
		});
		return toDisposable(() => {
			try {
				electronSession.setDisplayMediaRequestHandler?.(null);
			} catch {
				// セッションが先に消えた
			}
		});
	}

	/** getDisplayMedia の要求に答える（印が当たれば撮る源、当たらなければ空 = 断る）。 */
	resolveDisplayMedia(session: ParadisApiSession, request: { readonly frame: Pick<WebFrameMain, 'url'> | null; readonly videoRequested: boolean; readonly audioRequested: boolean }): Electron.Streams {
		const extensionId = extensionIdOfFrame(request.frame);
		if (!extensionId) {
			return {};
		}
		const now = this._now();
		const reservation = [...this._reservations.values()]
			.filter(candidate => candidate.session === session && candidate.extensionId === extensionId && candidate.armedUntil !== undefined && candidate.armedUntil >= now && candidate.expiresAt >= now)
			.sort((a, b) => (a.armedUntil ?? 0) - (b.armedUntil ?? 0))[0];
		if (!reservation) {
			return {};
		}
		this._reservations.delete(reservation.token);
		const target = reservation.target;
		if (target.kind === 'tab') {
			const view = this._viewOf(target.contents);
			if (!view || !paradisExtensionMayUseTab(view)) {
				return {};
			}
			const frame = target.contents.mainFrame;
			this._begin(reservation);
			return {
				video: frame,
				...(reservation.audio && request.audioRequested ? { audio: frame, enableLocalEcho: true } : {}),
			};
		}
		this._begin(reservation);
		return { video: { id: target.source.id, name: target.source.name } };
	}

	dispose(): void {
		for (const capture of [...this._active.values()]) {
			this._stop(capture);
		}
		this._reservations.clear();
		this._disposables.dispose();
	}

	// --- desktopCapture ---

	private async _chooseDesktopMedia(caller: IParadisExtensionApiCaller, requestId: number, sources: readonly string[], targetTab: Record<string, unknown> | undefined): Promise<{ readonly streamId: string; readonly options: { readonly canRequestAudioTrack: boolean } }> {
		if (sources.some(source => !SOURCE_TYPES.has(source))) {
			throw new ParadisExtensionApiError('Invalid source type specified.');
		}
		if (targetTab !== undefined) {
			// 印を使うのは、詰め物の入った拡張機能のページだけ（ウェブのページの getUserMedia は置き換えられない）
			throw new ParadisExtensionApiError('Para Code does not support targetTab for desktopCapture.chooseDesktopMedia; call it from an extension page');
		}
		if (caller.fromWorker) {
			throw new ParadisExtensionApiError('A target tab is required when called from a service worker context.');
		}
		const choices: { readonly label: string; readonly target: CaptureTarget }[] = [];
		if (sources.includes('tab')) {
			for (const tab of this._tabs.captureTabsFor(caller)) {
				choices.push({ label: localize('paradis.browserExtensions.capture.tab', "タブ: {0}", shorten(tab.title || tab.view.webContents.getURL())), target: { kind: 'tab', tabId: tab.tabId, contents: tab.view.webContents } });
			}
		}
		let note: string | undefined;
		if (sources.includes('window') || sources.includes('screen')) {
			if (paradisCaptureWindowsOffered(this._environment.platform)) {
				const own = this._environment.ownWindowSourceIds().map(id => id.split(':').slice(0, 2).join(':'));
				const windows = (await this._environment.getWindowSources().catch(() => []))
					.filter(source => source.id.startsWith('window:') && !own.includes(source.id.split(':').slice(0, 2).join(':')));
				for (const source of windows) {
					choices.push({ label: localize('paradis.browserExtensions.capture.window', "窓: {0}", shorten(source.name)), target: { kind: 'window', source } });
				}
				if (this._environment.screenAccess() !== 'granted') {
					note = localize('paradis.browserExtensions.capture.screenAccess', "ほかのアプリの窓を撮るには、OS の設定で Para Code に画面収録を許してください。");
				}
			} else {
				note = localize('paradis.browserExtensions.capture.windowsUnavailable', "この OS では、ほかのアプリの窓と画面全体は撮れません（Para Code の画面が写るのを防ぐため）。");
			}
		}
		const shown = choices.slice(0, MAX_CHOICES);
		const empty = { streamId: '', options: { canRequestAudioTrack: false } };
		if (shown.length === 0 && note === undefined) {
			note = localize('paradis.browserExtensions.capture.nothing', "撮れるものがありません。エージェントのタブと、エージェントと共有中のタブは撮れません。");
		}
		const picked = await this._environment.pick({ extensionName: this._environment.nameOf(caller.extension), choices: shown, note });
		const cancelKey = `${caller.extension.id}:${caller.connection}:${requestId}`;
		if (this._cancelled.delete(cancelKey) || picked === undefined || !shown[picked]) {
			return empty;
		}
		const target = shown[picked].target;
		const token = this._reserve(caller, target, target.kind === 'tab' && sources.includes('audio'));
		return { streamId: token, options: { canRequestAudioTrack: target.kind === 'tab' && sources.includes('audio') } };
	}

	// --- tabCapture ---

	/** Chromium の TabCaptureGetMediaStreamIdFunction に合わせる（ボタンを押したタブだけ・撮っている途中のタブは断る）。 */
	private _getMediaStreamId(caller: IParadisExtensionApiCaller, options: Record<string, unknown> | undefined): string {
		const tab = this._requireCaptureTab(caller, options?.targetTabId);
		return this._reserve(caller, { kind: 'tab', tabId: tab.tabId, contents: tab.view.webContents }, true);
	}

	/** tabCapture.capture: 前のウィンドウの前のタブを撮る印を作る。詰め物がそのまま getUserMedia に使う。 */
	private _capture(caller: IParadisExtensionApiCaller, options: Record<string, unknown>): { readonly streamId: string; readonly audio: boolean; readonly video: boolean } {
		const audio = options.audio === true;
		const video = options.video === true;
		if (!audio && !video) {
			throw new ParadisExtensionApiError('Capture failed. No audio or video requested.');
		}
		if (caller.fromWorker) {
			throw new ParadisExtensionApiError('Error starting tab capture');
		}
		const tab = this._requireCaptureTab(caller, undefined);
		return { streamId: this._reserve(caller, { kind: 'tab', tabId: tab.tabId, contents: tab.view.webContents }, audio), audio, video };
	}

	private _capturedTabs(caller: IParadisExtensionApiCaller): { readonly tabId: number; readonly status: string; readonly fullscreen: boolean }[] {
		return [...this._active.values()]
			.filter(capture => capture.session === caller.session && capture.extensionId === caller.extension.id && capture.target.kind === 'tab')
			.map(capture => ({ tabId: (capture.target as { readonly tabId: number }).tabId, status: 'active', fullscreen: false }));
	}

	private _requireCaptureTab(caller: IParadisExtensionApiCaller, targetTabId: unknown): IParadisCaptureTab {
		const tabs = this._tabs.captureTabsFor(caller);
		let tab: IParadisCaptureTab | undefined;
		if (targetTabId !== undefined && targetTabId !== null) {
			tab = typeof targetTabId === 'number' ? tabs.find(candidate => candidate.tabId === targetTabId) : undefined;
			if (!tab) {
				throw new ParadisExtensionApiError('Invalid tab specified.');
			}
		} else {
			const windowId = this._tabs.currentWindowIdFor();
			tab = tabs.find(candidate => candidate.windowId === windowId && candidate.active);
			if (!tab) {
				throw new ParadisExtensionApiError('Error finding tab to capture.');
			}
		}
		if (!this._tabs.hasTabCaptureGrant(caller.extension.id, tab.tabId)) {
			throw new ParadisExtensionApiError('Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.');
		}
		if ([...this._active.values()].some(capture => capture.target.kind === 'tab' && capture.target.contents === tab.view.webContents)) {
			throw new ParadisExtensionApiError('Cannot capture a tab with an active stream.');
		}
		return tab;
	}

	// --- 印 ---

	private _reserve(caller: IParadisExtensionApiCaller, target: CaptureTarget, audio: boolean): string {
		const now = this._now();
		for (const [token, reservation] of [...this._reservations]) {
			if (reservation.expiresAt < now) {
				this._reservations.delete(token);
			}
		}
		const token = `${PARADIS_CAPTURE_STREAM_ID_PREFIX}${randomUUID()}`;
		this._reservations.set(token, { token, session: caller.session, extensionId: caller.extension.id, target, audio, expiresAt: now + RESERVATION_TTL_MS });
		return token;
	}

	/** 詰め物が getDisplayMedia を呼ぶ直前に印を構える。構えられたら true。 */
	private _arm(caller: IParadisExtensionApiCaller, token: string): boolean {
		const reservation = this._reservations.get(token);
		const now = this._now();
		if (!reservation || reservation.session !== caller.session || reservation.extensionId !== caller.extension.id || reservation.expiresAt < now || caller.fromWorker) {
			return false;
		}
		reservation.armedUntil = now + ARM_TTL_MS;
		return true;
	}

	/** 詰め物のトラックが終わった（拡張機能が止めた）。 */
	private _release(caller: IParadisExtensionApiCaller, token: string): void {
		const capture = this._active.get(token);
		if (capture && capture.session === caller.session && capture.extensionId === caller.extension.id) {
			this._stop(capture, false);
		}
	}

	/** その拡張機能に、構えたままの印があるか。 */
	private _isArmedFor(extensionId: string | undefined): boolean {
		const now = this._now();
		return extensionId !== undefined && [...this._reservations.values()].some(reservation => reservation.extensionId === extensionId && reservation.armedUntil !== undefined && reservation.armedUntil >= now && reservation.expiresAt >= now);
	}

	private _begin(reservation: IReservation): void {
		const disposables = new DisposableStore();
		const capture: IActiveCapture = { token: reservation.token, session: reservation.session, extensionId: reservation.extensionId, target: reservation.target, disposables };
		this._active.set(reservation.token, capture);
		if (reservation.target.kind === 'tab') {
			const contents = reservation.target.contents;
			const onDestroyed = () => this._stop(capture);
			contents.once('destroyed', onDestroyed);
			disposables.add(toDisposable(() => contents.removeListener('destroyed', onDestroyed)));
			this._emitStatus(capture, 'active');
		}
	}

	private _stopForContents(contents: object): void {
		for (const capture of [...this._active.values()]) {
			if (capture.target.kind === 'tab' && capture.target.contents === contents) {
				this._stop(capture);
			}
		}
	}

	/** 撮るのをやめる。tell なら詰め物にトラックを止めさせる。 */
	private _stop(capture: IActiveCapture, tell = true): void {
		if (this._active.get(capture.token) !== capture) {
			return;
		}
		this._active.delete(capture.token);
		capture.disposables.dispose();
		const namespace = capture.target.kind === 'tab' ? PARADIS_SHIM_TAB_CAPTURE_NAMESPACE : PARADIS_SHIM_DESKTOP_CAPTURE_NAMESPACE;
		if (tell) {
			this._host.emit({ session: capture.session, extensionId: capture.extensionId }, namespace, 'onStop', [capture.token]);
		}
		if (capture.target.kind === 'tab') {
			this._emitStatus(capture, 'stopped');
		}
	}

	private _emitStatus(capture: IActiveCapture, status: 'active' | 'stopped'): void {
		if (capture.target.kind === 'tab') {
			this._host.emit({ session: capture.session, extensionId: capture.extensionId }, PARADIS_SHIM_TAB_CAPTURE_NAMESPACE, 'onStatusChanged', [{ tabId: capture.target.tabId, status, fullscreen: false }]);
		}
	}

	private _viewOf(contents: WebContents): { readonly webContents: WebContents; isAgentTab(): boolean } | undefined {
		if (contents.isDestroyed()) {
			return undefined;
		}
		return this._tabs.viewOfContents(contents);
	}

	private _now(): number {
		return this._environment.now?.() ?? Date.now();
	}
}
