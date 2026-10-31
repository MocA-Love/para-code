/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { getWindow } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';

// 見えていないターミナルの GPU レンダラ(WebGL)を外して、GPU のメモリを返す(既定オフ)。
//
// WebGL のターミナルは 1 本ごとにコンテキストと文字の画像(texture atlas)を GPU に持つ。
// 裏のタブや待避中のスペースのターミナルも持ち続けるので、本数が多いと GPU のメモリを
// 大きく使う。設定がオンのとき、見えなくなってから猶予(PARADIS_HIDDEN_GPU_RELEASE_DELAY)が
// 過ぎたら外し、見えるようになったら付け直す。猶予のうちに戻れば外さない。
//
// 「見えているか」は xterm の要素の IntersectionObserver で読む。タブの切り替え・エディタの
// 裏のタブ・スペースの待避(要素が DOM から外れる)を、どれも同じ信号で拾える。xterm 自身も
// 同じ方法で裏の描画を止めている(RenderService)。
//
// 外している間は DOM レンダラが代わりに入るが、裏では描画が止まっているので何も描かない。
// バッファ・スクロール位置・選択は描画方式と無関係に xterm の中に残る。

/** 見えなくなってから GPU レンダラを外すまでの猶予(ミリ秒)。タブをさっと切り替えただけなら外さない。 */
export const PARADIS_HIDDEN_GPU_RELEASE_DELAY = 5000;

/** 設定のキー。 */
export const PARADIS_TERMINAL_RELEASE_HIDDEN_GPU_SETTING = 'paradis.terminal.releaseHiddenGpu';

/** {@link ParadisHiddenGpuRelease} が端末に頼む操作。 */
export interface IParadisHiddenGpuReleaseHost {
	/** 設定がオンか。 */
	isEnabled(): boolean;
	/** いま GPU レンダラで描いているか。 */
	hasGpuRenderer(): boolean;
	/** GPU レンダラを外す。寸法の計算し直しと画像の破棄はしないこと(戻ったときに pty の大きさが変わらないように)。 */
	release(): void;
	/** GPU レンダラを付け直す。 */
	reacquire(): void;
}

/**
 * 端末 1 本ぶんの「見えない間は GPU レンダラを外す」状態。
 *
 * 付け直すのは自分が外した端末だけ。DOM レンダラで動いている端末に GPU レンダラを足すことはない。
 */
export class ParadisHiddenGpuRelease extends Disposable {
	private _visible = true;
	private _released = false;
	private readonly _releaseScheduler: RunOnceScheduler;
	private readonly _observer = this._register(new MutableDisposable());
	private _observedWindow: Window | undefined;

	constructor(
		private readonly _host: IParadisHiddenGpuReleaseHost,
		delay: number = PARADIS_HIDDEN_GPU_RELEASE_DELAY,
	) {
		super();
		this._releaseScheduler = this._register(new RunOnceScheduler(() => this._releaseIfStillHidden(), delay));
	}

	/** 自分が外したまま、まだ付け直していないか。外している間は、ほかの経路から GPU レンダラを付けない。 */
	get isReleased(): boolean {
		return this._released;
	}

	/**
	 * 要素の見え方を見張る。端末が別のウィンドウへ移ったときは、そのウィンドウで見張り直す
	 * (IntersectionObserver は自分のウィンドウの画面に対してしか交差を判定しない)。
	 */
	observe(element: HTMLElement): void {
		const targetWindow = getWindow(element);
		if (this._observer.value && this._observedWindow === targetWindow) {
			return;
		}
		const observer = new targetWindow.IntersectionObserver(entries => {
			const entry = entries[entries.length - 1];
			this.setVisible(entry.isIntersecting);
		}, { threshold: 0 });
		observer.observe(element);
		this._observedWindow = targetWindow;
		this._observer.value = toDisposable(() => observer.disconnect());
	}

	/** 見え方が変わった。 */
	setVisible(visible: boolean): void {
		if (visible === this._visible) {
			return;
		}
		this._visible = visible;
		if (visible) {
			this._releaseScheduler.cancel();
			if (this._released) {
				this._released = false;
				this._host.reacquire();
			}
			return;
		}
		if (this._host.isEnabled() && this._host.hasGpuRenderer()) {
			this._releaseScheduler.schedule();
		}
	}

	private _releaseIfStillHidden(): void {
		if (this._visible || this._released || !this._host.isEnabled() || !this._host.hasGpuRenderer()) {
			return;
		}
		this._released = true;
		this._host.release();
	}
}
