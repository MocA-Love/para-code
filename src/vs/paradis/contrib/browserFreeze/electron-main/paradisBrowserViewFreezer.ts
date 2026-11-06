/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { paradisIsWebContentsHeldByAgent } from '../../browserDownloads/electron-main/paradisAgentDownloads.js';
import { PARADIS_BROWSER_FREEZE_AFTER_HIDDEN_MS } from '../common/paradisBrowserFreeze.js';

/** 休ませる対象として見る BrowserView の部分（テストで偽物を渡せるように絞る）。 */
export interface IParadisFreezableBrowserView {
	readonly webContents: {
		isDestroyed(): boolean;
		isCurrentlyAudible(): boolean;
		isDevToolsOpened(): boolean;
		isBeingCaptured(): boolean;
	};
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

/** そのタブを休ませていれば起こす（エージェントが手にした・撮るなど、ページを動かす前に呼ぶ）。 */
export function paradisThawBrowserView(view: object): void {
	thawers.get(view)?.();
}

interface IViewState {
	timer: unknown;
	frozen: boolean;
	readonly store: DisposableStore;
}

/**
 * 長く隠れたままの内蔵ブラウザのタブを、CDP の `Page.setWebLifecycleState` で凍結する（ページを捨てない休止）。
 *
 * 凍結したページはタイマー・描画・ネットワークの処理が止まり、DOM・JS の状態・スクロール位置・入力中の値はそのまま
 * 残る。表示したら `active` に戻す。読み込み直しが起きる discard は使わない（スペースを切り替えて戻っても状態を
 * 保つため）。エージェントが手にしているタブ、音を鳴らしているタブ、DevTools を開いているタブ、映像を撮られている
 * タブは止めない（止める時点で該当すれば、もう一度同じ時間を待つ）。
 */
export class ParadisBrowserViewFreezer extends Disposable {

	private readonly views = new Map<IParadisFreezableBrowserView, IViewState>();

	constructor(
		source: IParadisFreezableBrowserViewSource,
		private readonly isEnabled: () => boolean,
		private readonly delayMs: number = PARADIS_BROWSER_FREEZE_AFTER_HIDDEN_MS,
		private readonly timer: IParadisFreezeTimer = defaultTimer,
		private readonly isHeldByAgent: (webContents: object) => boolean = paradisIsWebContentsHeldByAgent,
	) {
		super();
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
		const state: IViewState = { timer: undefined, frozen: false, store };
		this.views.set(view, state);
		thawers.set(view, () => this.thaw(view, state));
		store.add(view.onDidChangeVisibility(({ visible }) => {
			if (visible) {
				this.timer.clear(state.timer);
				state.timer = undefined;
				this.thaw(view, state);
			} else {
				this.schedule(view, state);
			}
		}));
		const untrack = () => {
			this.timer.clear(state.timer);
			state.timer = undefined;
			this.views.delete(view);
			thawers.delete(view);
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
			if (!this.canFreeze(view)) {
				// 今は止められない（エージェントが手にしている・音が鳴っている・設定がオフ）。隠れたままならまた見る
				this.schedule(view, state);
				return;
			}
			this.freeze(view, state);
		}, this.delayMs);
	}

	private canFreeze(view: IParadisFreezableBrowserView): boolean {
		try {
			const webContents = view.webContents;
			return this.isEnabled()
				&& !webContents.isDestroyed()
				&& !view.getState().visible
				&& !this.isHeldByAgent(webContents)
				&& !webContents.isCurrentlyAudible()
				&& !webContents.isDevToolsOpened()
				&& !webContents.isBeingCaptured();
		} catch {
			return false;
		}
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
			state.store.dispose();
		}
		this.views.clear();
	}
}
