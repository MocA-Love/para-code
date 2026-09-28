/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「裏に回った」スマホの PC 側の後始末（W2-34）。
//
// アプリは裏に回っても最大30秒ソケットを保つが、**iOS は裏に回ったアプリを数秒で止める**ので、
// アプリの30秒のタイマーは発火しないことが多い。ソケットは半開きのまま残り、PC から見るとセッションが
// 生きたままになる（ブラウザミラーのキャプチャ・ターミナル出力・チャットの購読・スマホ幅合わせが続く）。
// そこで PC 側でも期限を持ち、「裏に回った」を受けてから {@link PARADIS_BACKGROUND_SESSION_EXPIRY_MS} の
// 間に「前面に戻った」が来なければ、presence offline と同じ後始末をする。アプリの期限（30秒）より長く
// しておき、30秒以内に戻ったアプリの接続を PC が先に捨てないようにする。
//
// もう1つ、裏に回る直前の約1往復の間に出た通知は、PC がまだ「前面」と信じてプッシュを送らず、アプリは
// もう裏にいてバナーを出さない。「裏に回った」を受けた時点で、直前 {@link PARADIS_BACKGROUND_REPUSH_WINDOW_MS}
// に信用してプッシュしなかった通知を、そのスマホへプッシュし直す（アプリの一覧は ID で重複を弾く）。

/** 「裏に回った」を受けてから、前面に戻らなければセッションを捨てるまでの時間。 */
export const PARADIS_BACKGROUND_SESSION_EXPIRY_MS = 40_000;
/** 「裏に回った」を受けたとき、プッシュし直す通知の遡る範囲。 */
export const PARADIS_BACKGROUND_REPUSH_WINDOW_MS = 3_000;
const RECENT_TRUSTED_LIMIT = 10;

export interface IParadisBackgroundGraceTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** 裏に回ったスマホごとの期限。 */
export class ParadisBackgroundSessionWatch {

	private readonly timers = new Map<string, unknown>();

	constructor(private readonly clock: IParadisBackgroundGraceTimers = globalThis) { }

	/** 期限を張る（張り直すと前の期限は捨てる）。期限が来たら `onExpire`。 */
	begin(mobileId: string, onExpire: () => void): void {
		this.end(mobileId);
		const handle = this.clock.setTimeout(() => {
			if (this.timers.get(mobileId) === handle) {
				this.timers.delete(mobileId);
				onExpire();
			}
		}, PARADIS_BACKGROUND_SESSION_EXPIRY_MS);
		this.timers.set(mobileId, handle);
	}

	/** 前面に戻った・セッションが消えた。 */
	end(mobileId: string): void {
		const handle = this.timers.get(mobileId);
		if (handle !== undefined) {
			this.clock.clearTimeout(handle);
			this.timers.delete(mobileId);
		}
	}

	dispose(): void {
		for (const handle of this.timers.values()) {
			this.clock.clearTimeout(handle);
		}
		this.timers.clear();
	}
}

/** 信用してプッシュしなかった直近の通知（スマホごと、{@link PARADIS_BACKGROUND_REPUSH_WINDOW_MS} ぶん）。 */
export class ParadisRecentTrustedNotifies {

	private readonly byMobile = new Map<string, { readonly at: number; readonly bytes: Uint8Array }[]>();

	add(mobileId: string, bytes: Uint8Array, at: number): void {
		const list = (this.byMobile.get(mobileId) ?? []).filter(entry => at - entry.at <= PARADIS_BACKGROUND_REPUSH_WINDOW_MS);
		list.push({ at, bytes });
		this.byMobile.set(mobileId, list.slice(-RECENT_TRUSTED_LIMIT));
	}

	/** 直近の分を取り出して空にする（「裏に回った」を受けたとき）。 */
	take(mobileId: string, now: number): Uint8Array[] {
		const list = this.byMobile.get(mobileId) ?? [];
		this.byMobile.delete(mobileId);
		return list.filter(entry => now - entry.at <= PARADIS_BACKGROUND_REPUSH_WINDOW_MS).map(entry => entry.bytes);
	}

	forget(mobileId: string): void {
		this.byMobile.delete(mobileId);
	}
}
