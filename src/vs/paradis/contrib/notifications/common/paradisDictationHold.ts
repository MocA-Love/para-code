/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable } from '../../../../base/common/lifecycle.js';

/** 1つのウィンドウの音声入力で読み上げを止めておける上限。 */
export const PARADIS_DICTATION_HOLD_LIMIT_MS = 10 * 60_000;

export interface IParadisDictationHoldTimers {
	set(callback: () => void, ms: number): IDisposable;
}

const defaultTimers: IParadisDictationHoldTimers = {
	set: (callback, ms) => {
		const handle = setTimeout(callback, ms);
		return { dispose: () => clearTimeout(handle) };
	},
};

/**
 * どのウィンドウ（接続）が音声入力中かを持ち、1つでもあれば「止める」と判定する。
 *
 * 上限はウィンドウごと。音声入力中と知らせてから {@link PARADIS_DICTATION_HOLD_LIMIT_MS} たっても
 * 終わりが届かないウィンドウだけを外す（モデルの初回ダウンロードや、upstream のセッション数が
 * 戻らなかったときに、通知がずっと鳴らなくなるのを防ぐ）。同じウィンドウがもう一度「音声入力中」と
 * 知らせてきたら（音声入力の状態が動くたびに送られる）、そこから数え直す。
 */
export class ParadisDictationHold implements IDisposable {

	private readonly clients = new Map<string, IDisposable>();

	constructor(
		/** 止めるかどうかが変わったとき。 */
		private readonly onDidChangeHeld: (held: boolean) => void,
		private readonly onDidExpire: (client: string) => void = () => { },
		private readonly timers: IParadisDictationHoldTimers = defaultTimers,
		private readonly limitMs = PARADIS_DICTATION_HOLD_LIMIT_MS,
	) { }

	get held(): boolean {
		return this.clients.size > 0;
	}

	set(client: string, active: boolean): void {
		const before = this.held;
		this.clients.get(client)?.dispose();
		this.clients.delete(client);
		if (active) {
			this.clients.set(client, this.timers.set(() => {
				this.clients.delete(client);
				this.onDidExpire(client);
				if (!this.held) {
					this.onDidChangeHeld(false);
				}
			}, this.limitMs));
		}
		if (before !== this.held) {
			this.onDidChangeHeld(this.held);
		}
	}

	dispose(): void {
		for (const timer of this.clients.values()) {
			timer.dispose();
		}
		this.clients.clear();
	}
}
