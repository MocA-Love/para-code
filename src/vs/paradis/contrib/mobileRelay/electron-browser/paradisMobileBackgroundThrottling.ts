/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { disposableTimeout } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, IDisposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { IParadisMobileStatus } from '../common/paradisMobileRelay.js';

/**
 * モバイルが繋がっている間、このウィンドウの背景スロットリングを止める。
 *
 * 通常のウィンドウは隠れる（他のウィンドウに覆われる・最小化する）と Chromium のタイマーの間引きを受け、
 * 5 分を過ぎると連鎖したタイマーが 1 分ごとにまとめて起こされる（intensive wake-up throttling）。モバイルの要求は
 * このウィンドウの renderer が処理するので、間引かれると SSH の接続先への呼び出しや応答が分単位で遅れる。
 *
 * 切り替えは upstream の `INativeHostService.setBackgroundThrottling`（`webContents.setBackgroundThrottling`）で行う。
 * これはタイマーだけでなく Page Visibility API にも効く。止めている間は、隠れたウィンドウでも
 * `document.visibilityState` が `visible` のままになり、隠れている間は休むはずの描画やアニメーションも動く
 * （電池と CPU を使う）。だから止めるのはモバイルがオンラインの間だけにし、オフラインになってから
 * {@link PARADIS_MOBILE_THROTTLING_RELEASE_GRACE_MS} 待って戻す（一時的な切断のたびに切り替えないため）。
 *
 * 順序への依存: チャット（upstream の `ChatSuspendThrottlingHandler`、`chat.contribution.ts`）も同じ値を
 * 要求の最中だけ切り替え、終わると間引きを戻す。どちらが後に main へ届くかで結果が決まるので、チャットの状態が
 * 変わったら、こちらの値をいったん後回しにして送り、少し遅らせてもう一度送る（チャットの呼び出しが後に
 * 着いても上書きし直す）。手を離すときはチャットが決める値（要求の最中なら止める）を送る。
 * 一度も止めていなければ何も送らない（リレーを使わない人は従来どおり）。
 */
export class ParadisMobileBackgroundThrottlingKeeper extends Disposable {

	private readonly keep = observableValue<boolean>(this, false);
	/** 止める側の値を送ったことがあるか（手を離すときに 1 回だけ戻すため）。 */
	private holding = false;
	private readonly pendingSends = this._register(new DisposableStore());
	private readonly pendingRelease = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly setBackgroundThrottling: (allowed: boolean) => void,
		chatRequestInProgress: IObservable<boolean>,
		/** タイマー（テストでは差し替える）。 */
		private readonly schedule: (callback: () => void, ms: number) => IDisposable = (callback, ms) => disposableTimeout(callback, ms),
	) {
		super();
		this._register(autorun(reader => {
			const keep = this.keep.read(reader);
			const chatRunning = chatRequestInProgress.read(reader);
			if (keep) {
				this.holding = true;
				this.send(false);
			} else if (this.holding) {
				this.holding = false;
				this.send(!chatRunning);
			}
		}));
	}

	/** リレーの設定と状態から、止めるかを決め直す。 */
	update(enabled: boolean, status: IParadisMobileStatus | undefined): void {
		if (paradisShouldKeepWindowUnthrottledForMobile(enabled, status)) {
			this.pendingRelease.clear();
			this.keep.set(true, undefined);
			return;
		}
		// モバイルがオフラインになっただけなら、猶予の後に戻す（リレーを無効にした・ペアリングを外したならすぐ戻す）
		const pairedAndEnabled = enabled && status !== undefined && status.state !== 'disabled' && status.pairedDevices.length > 0;
		if (pairedAndEnabled && this.keep.get()) {
			if (this.pendingRelease.value === undefined) {
				this.pendingRelease.value = this.schedule(() => {
					this.pendingRelease.clear();
					this.keep.set(false, undefined);
				}, PARADIS_MOBILE_THROTTLING_RELEASE_GRACE_MS);
			}
			return;
		}
		this.pendingRelease.clear();
		this.keep.set(false, undefined);
	}

	private send(allowed: boolean): void {
		this.pendingSends.clear();
		// 同じ変化でチャットが送る値より後に着くよう後回しにし、少し後にもう一度送る
		this.pendingSends.add(this.schedule(() => this.setBackgroundThrottling(allowed), 0));
		this.pendingSends.add(this.schedule(() => this.setBackgroundThrottling(allowed), PARADIS_MOBILE_THROTTLING_RESEND_MS));
	}
}

/** モバイルがオフラインになってから、背景スロットリングを戻すまでの猶予。 */
export const PARADIS_MOBILE_THROTTLING_RELEASE_GRACE_MS = 60_000;

/** 止める・戻す値を送り直すまでの間（チャットの呼び出しと前後しても最後にこちらの値が残るように）。 */
export const PARADIS_MOBILE_THROTTLING_RESEND_MS = 1_000;

/** リレーが有効で、ペアリング済みのモバイルがいまオンラインのときだけ止める。 */
export function paradisShouldKeepWindowUnthrottledForMobile(enabled: boolean, status: IParadisMobileStatus | undefined): boolean {
	return enabled && status !== undefined && status.state !== 'disabled' && status.pairedDevices.length > 0 && status.onlineMobiles > 0;
}

/** このウィンドウの実体を作る（DI のサービスはここで受け取る）。 */
export function paradisCreateMobileBackgroundThrottlingKeeper(nativeHostService: INativeHostService, chatService: IChatService): ParadisMobileBackgroundThrottlingKeeper {
	return new ParadisMobileBackgroundThrottlingKeeper(allowed => {
		// ウィンドウを閉じている最中などに失敗しても、次の切り替えで送り直すので握りつぶす
		nativeHostService.setBackgroundThrottling(allowed).catch(() => { });
	}, chatService.requestInProgressObs);
}
