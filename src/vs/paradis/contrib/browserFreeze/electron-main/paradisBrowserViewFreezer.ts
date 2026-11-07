/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { paradisIsWebContentsHeldByAgent } from '../../browserDownloads/electron-main/paradisAgentDownloads.js';
import { paraBrowserViewLastCaptureAt, paraOnWillCaptureBrowserView } from '../../../../platform/browserView/electron-main/paraBrowserViewCaptureWatch.js';
import { PARADIS_BROWSER_FREEZE_AFTER_HIDDEN_MS } from '../common/paradisBrowserFreeze.js';

/** この時間の内にスクリーンショットを撮られたタブ（ライブウィンドウのタイルなど、誰かが見ているタブ）は止めない。 */
const PARADIS_BROWSER_FREEZE_WATCHED_MS = 5 * 60_000;
/** 隠れる瞬間にエディタが撮る 1 枚（代わりに出す絵）を「見ている」と取り違えないための猶予。 */
const PARADIS_BROWSER_FREEZE_HIDE_CAPTURE_GRACE_MS = 10_000;

/** 休ませる対象として見る BrowserView の部分（テストで偽物を渡せるように絞る）。 */
export interface IParadisFreezableBrowserView {
	readonly webContents: {
		isDestroyed(): boolean;
		isCurrentlyAudible(): boolean;
		isDevToolsOpened(): boolean;
		isBeingCaptured(): boolean;
		getURL(): string;
	};
	/** タブのプロファイルのサイトの許可（通知を許可したサイトは止めない）。 */
	readonly session?: { readonly permissions: { serialize(): { readonly origins: Readonly<Record<string, Readonly<Record<string, string | undefined>>>> } } };
	readonly debugger: { sendCommandRaw(method: string, params?: unknown): Promise<unknown> };
	readonly onDidChangeVisibility: Event<{ readonly visible: boolean }>;
	readonly onDidClose: Event<void>;
	getState(): { readonly visible: boolean };
}

/** 新しくできたタブを知らせる側（IBrowserViewMainService の部分）。 */
export interface IParadisFreezableBrowserViewSource {
	readonly onDidCreateBrowserView: Event<{ readonly info: { readonly id: string } }>;
	tryGetBrowserView(id: string): IParadisFreezableBrowserView | undefined;
}

/** テストで差し替えるタイマー。 */
export interface IParadisFreezeTimer {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

const defaultTimer: IParadisFreezeTimer = {
	set: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		(handle as unknown as { unref?(): void }).unref?.();
		return handle;
	},
	clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 休ませたタブを起こす処理（BrowserView → 起こす）。エージェントがタブを手にしたときに CDP の通り道から呼ぶ。 */
const thawers = new WeakMap<object, () => void>();

/** そのタブ（BrowserView、またはその webContents）を休ませていれば起こす（エージェントが手にした・撮るなど、ページを動かす前に呼ぶ）。 */
export function paradisThawBrowserView(viewOrWebContents: object): void {
	thawers.get(viewOrWebContents)?.();
}

/** 拡張機能（chrome.debugger）がつないでいるタブの webContents。つないでいる間は休ませない。 */
const extensionDebuggerAttached = new WeakSet<object>();

/** 拡張機能がタブにデバッガをつないだ（true）・外した（false）。つないだら、休ませていたタブを起こす。 */
export function paradisSetExtensionDebuggerAttached(webContents: object, attached: boolean): void {
	if (attached) {
		extensionDebuggerAttached.add(webContents);
		paradisThawBrowserView(webContents);
	} else {
		extensionDebuggerAttached.delete(webContents);
	}
}

interface IViewState {
	timer: unknown;
	frozen: boolean;
	/** 最後に隠れた時刻。隠れる瞬間の撮影（エディタの代わりの絵）は「見ている」に数えないために使う。 */
	hiddenAt: number;
	readonly store: DisposableStore;
}

/**
 * 長く隠れたままの内蔵ブラウザのタブを、CDP の `Page.setWebLifecycleState` で凍結する（ページを捨てない休止）。
 *
 * 凍結したページはタイマー・描画・ネットワークの処理が止まり、DOM・JS の状態・スクロール位置・入力中の値はそのまま
 * 残る。表示したら `active` に戻す。読み込み直しが起きる discard は使わない（スペースを切り替えて戻っても状態を
 * 保つため）。エージェントが手にしているタブ、音を鳴らしているタブ、DevTools を開いているタブ、映像を撮られている
 * タブ、最近スクリーンショットを撮られたタブ（ライブウィンドウのタイル）、通知を許可したサイトのタブ、拡張機能が
 * デバッガをつないでいるタブは止めない
 * （止める時点で該当すれば、もう一度同じ時間を待つ）。
 */
export class ParadisBrowserViewFreezer extends Disposable {

	private readonly views = new Map<IParadisFreezableBrowserView, IViewState>();

	constructor(
		source: IParadisFreezableBrowserViewSource,
		private readonly isEnabled: () => boolean,
		private readonly delayMs: number = PARADIS_BROWSER_FREEZE_AFTER_HIDDEN_MS,
		private readonly timer: IParadisFreezeTimer = defaultTimer,
		private readonly isHeldByAgent: (webContents: object) => boolean = paradisIsWebContentsHeldByAgent,
		private readonly lastCaptureAt: (view: object) => number | undefined = paraBrowserViewLastCaptureAt,
		onWillCapture: (listener: (view: object) => void) => () => void = paraOnWillCaptureBrowserView,
		private readonly now: () => number = Date.now,
	) {
		super();
		// 撮られるタブ（ライブウィンドウのタイル・エージェントのスクリーンショット）を止めていたら、撮る前に起こす
		const stopWatchingCaptures = onWillCapture(view => {
			const state = this.views.get(view as IParadisFreezableBrowserView);
			if (state?.frozen) {
				this.thaw(view as IParadisFreezableBrowserView, state);
				this.schedule(view as IParadisFreezableBrowserView, state);
			}
		});
		this._register({ dispose: stopWatchingCaptures });
		this._register(source.onDidCreateBrowserView(({ info }) => {
			const view = source.tryGetBrowserView(info.id);
			if (view) {
				this.track(view);
			}
		}));
		this._register({ dispose: () => this.clearAll() });
	}

	/** 休ませているタブの数（テストと診断用）。 */
	get frozenCount(): number {
		let count = 0;
		for (const state of this.views.values()) {
			if (state.frozen) {
				count++;
			}
		}
		return count;
	}

	private track(view: IParadisFreezableBrowserView): void {
		if (this.views.has(view)) {
			return;
		}
		const store = new DisposableStore();
		const state: IViewState = { timer: undefined, frozen: false, hiddenAt: this.now(), store };
		this.views.set(view, state);
		const thaw = () => this.thaw(view, state);
		thawers.set(view, thaw);
		thawers.set(view.webContents, thaw);
		store.add(view.onDidChangeVisibility(({ visible }) => {
			if (visible) {
				this.timer.clear(state.timer);
				state.timer = undefined;
				this.thaw(view, state);
			} else {
				state.hiddenAt = this.now();
				this.schedule(view, state);
			}
		}));
		const untrack = () => {
			this.timer.clear(state.timer);
			state.timer = undefined;
			this.views.delete(view);
			thawers.delete(view);
			thawers.delete(view.webContents);
			store.dispose();
		};
		store.add(view.onDidClose(untrack));
		try {
			// 裏で開いたまま一度も表示していないタブも数える
			if (!view.getState().visible) {
				this.schedule(view, state);
			}
		} catch {
			// 状態が読めなければ、次に隠れたときから数える
		}
	}

	private schedule(view: IParadisFreezableBrowserView, state: IViewState): void {
		this.timer.clear(state.timer);
		state.timer = this.timer.set(() => {
			state.timer = undefined;
			if (this.views.get(view) !== state || state.frozen) {
				return;
			}
			if (!this.canFreeze(view, state)) {
				// 今は止められない（エージェントが手にしている・音が鳴っている・設定がオフ）。隠れたままならまた見る
				this.schedule(view, state);
				return;
			}
			this.freeze(view, state);
		}, this.delayMs);
	}

	private canFreeze(view: IParadisFreezableBrowserView, state: IViewState): boolean {
		try {
			const webContents = view.webContents;
			return this.isEnabled()
				&& !webContents.isDestroyed()
				&& !view.getState().visible
				&& !this.isHeldByAgent(webContents)
				&& !webContents.isCurrentlyAudible()
				&& !webContents.isDevToolsOpened()
				&& !webContents.isBeingCaptured()
				&& !extensionDebuggerAttached.has(webContents)
				&& !this.isWatched(view, state)
				&& !this.allowsNotifications(view);
		} catch {
			return false;
		}
	}

	/** 隠れた後に撮られたタブか（ライブウィンドウのタイルなど）。隠れる瞬間に撮る 1 枚は数えない。 */
	private isWatched(view: IParadisFreezableBrowserView, state: IViewState): boolean {
		const capturedAt = this.lastCaptureAt(view);
		return capturedAt !== undefined
			&& capturedAt > state.hiddenAt + PARADIS_BROWSER_FREEZE_HIDE_CAPTURE_GRACE_MS
			&& this.now() - capturedAt < PARADIS_BROWSER_FREEZE_WATCHED_MS;
	}

	/** 通知を許可したサイトのタブか（隠したまま通知を待つ使い方を止めない）。 */
	private allowsNotifications(view: IParadisFreezableBrowserView): boolean {
		let origin: string;
		try {
			origin = new URL(view.webContents.getURL()).origin;
		} catch {
			return false;
		}
		const origins = view.session?.permissions.serialize().origins ?? {};
		for (const [key, decisions] of Object.entries(origins)) {
			if (decisions.notifications !== 'allow') {
				continue;
			}
			try {
				if (new URL(key).origin === origin) {
					return true;
				}
			} catch {
				if (key === origin) {
					return true;
				}
			}
		}
		return false;
	}

	private freeze(view: IParadisFreezableBrowserView, state: IViewState): void {
		state.frozen = true;
		this.send(view, 'frozen').then(ok => {
			if (!ok && state.frozen) {
				// 凍結できなかった（ページが受け付けない・CDP が使えない）。起こす必要は無い
				state.frozen = false;
			}
		});
	}

	private thaw(view: IParadisFreezableBrowserView, state: IViewState): void {
		if (!state.frozen) {
			return;
		}
		state.frozen = false;
		void this.send(view, 'active');
	}

	private async send(view: IParadisFreezableBrowserView, lifecycleState: 'frozen' | 'active'): Promise<boolean> {
		try {
			if (view.webContents.isDestroyed()) {
				return false;
			}
			await view.debugger.sendCommandRaw('Page.setWebLifecycleState', { state: lifecycleState });
			return true;
		} catch {
			return false;
		}
	}

	private clearAll(): void {
		for (const [view, state] of this.views) {
			this.timer.clear(state.timer);
			thawers.delete(view);
			thawers.delete(view.webContents);
			state.store.dispose();
		}
		this.views.clear();
	}
}
