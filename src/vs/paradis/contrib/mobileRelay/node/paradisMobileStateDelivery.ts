/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

function equalBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
	if (left === undefined || left.byteLength !== right.byteLength) {
		return false;
	}
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

/** 変わっていない State の代わりに送る返事（state.unchanged.v1）。`identity` が送る State の版と一致するときだけ使う。 */
export interface IParadisMobileUnchangedStateReply {
	readonly identity: string;
	readonly reply: Uint8Array;
}

export interface IParadisMobileStateOffer {
	/** この State の版（desktopEpoch と revision）。 */
	readonly identity?: string;
	/** アプリが手元の版を添えて求めた（要求への返事のときだけ）。 */
	readonly unchanged?: IParadisMobileUnchangedStateReply;
}

interface IPendingState {
	payload: Uint8Array;
	force: boolean;
	identity: string | undefined;
	unchanged: IParadisMobileUnchangedStateReply | undefined;
	send: (payload: Uint8Array) => Promise<void>;
	readonly waiters: { resolve(sent: boolean): void; reject(error: unknown): void }[];
}

/**
 * Tracks the last successfully delivered Desktop State for one mobile session.
 *
 * 1 台のスマホへ同時に送るのは 1 件だけにし、送っている間に来た State は「次に送る 1 件」の枠を最新の値で
 * 置き換える（設計 4 章 #15）。遅いスマホへの送信を待つ間に古い State を積み上げず、メモリは送信中と次の
 * 1 件の分だけで済む。要求への返事（force）は置き換えても消えない（次の 1 件が必ず送られる）。
 */
export class ParadisMobileStateDelivery {
	private lastDelivered: Uint8Array | undefined;
	private generation = 0;
	private pending: IPendingState | undefined;
	private sending = false;

	/**
	 * payloadを配送する。`force`がfalseで直近の成功payloadと完全一致する場合だけ省略する。
	 * 送信成功後にのみpayloadを記録し（参照を受け取る）、実際に送信した場合はtrue、省略時はfalseを返す。
	 * 送信中なら次の 1 件として預かり、その後に来た値で置き換える（置き換えられた側も、置き換えた値の結果で解決する）。
	 */
	deliver(payload: Uint8Array, force: boolean, send: (payload: Uint8Array) => Promise<void>, offer: IParadisMobileStateOffer = {}): Promise<boolean> {
		return new Promise<boolean>((resolve, reject) => {
			const waiter = { resolve, reject };
			const previous = this.pending;
			this.pending = {
				payload,
				force: force || previous?.force === true,
				identity: offer.identity,
				// 新しい要求（force）の答え方はその要求に従う。ただの配信は前の要求の答え方を引き継ぐ
				unchanged: force ? offer.unchanged : previous?.unchanged,
				send,
				waiters: [...(previous?.waiters ?? []), waiter],
			};
			if (!this.sending) {
				void this.drain();
			}
		});
	}

	private async drain(): Promise<void> {
		this.sending = true;
		try {
			for (let item = this.take(); item !== undefined; item = this.take()) {
				await this.sendOne(item);
			}
		} finally {
			this.sending = false;
		}
	}

	private take(): IPendingState | undefined {
		const item = this.pending;
		this.pending = undefined;
		return item;
	}

	private async sendOne(item: IPendingState): Promise<void> {
		const settle = (sent: boolean) => item.waiters.forEach(waiter => waiter.resolve(sent));
		try {
			const same = equalBytes(this.lastDelivered, item.payload);
			if (!item.force && same) {
				settle(false);
				return;
			}
			if (item.force && same && item.unchanged !== undefined && item.identity !== undefined && item.unchanged.identity === item.identity) {
				// アプリは同じ版を持っている。全量の代わりに「変わっていない」を返す
				await item.send(item.unchanged.reply);
				settle(true);
				return;
			}
			const generation = this.generation;
			// payload は呼び出し元（sendDesktopState）が都度新規生成するため、ここで所有権を
			// 受け取る。防御コピーは不要で、lastDelivered が同じ参照を保持する。
			await item.send(item.payload);
			if (this.generation === generation) {
				this.lastDelivered = item.payload;
			}
			settle(true);
		} catch (error) {
			item.waiters.forEach(waiter => waiter.reject(error));
		}
	}

	/**
	 * 暗号セッション境界で比較対象を破棄する。
	 * reset前に開始した送信が後から完了しても、新しい世代の比較対象には採用しない。
	 * まだ送っていない次の 1 件は送らずに捨てる（古い鍵のセッション宛てなので）。
	 */
	reset(): void {
		this.generation++;
		this.lastDelivered = undefined;
		const dropped = this.take();
		dropped?.waiters.forEach(waiter => waiter.resolve(false));
	}
}
