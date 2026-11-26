/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IntervalTimer } from '../../../../base/common/async.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';

/** 帯の「ターミナルを開く」から開いたペインを、選択画面が消えたらチャット表示へ戻すのに使うもの。 */
export interface IParadisAgentChatChoiceReturnHost {
	/** ペインの画面に選択画面が出ているか。 */
	showsChoiceMenu(instanceId: number): boolean;
	/** ペインがまだあるか。 */
	exists(instanceId: number): boolean;
	/** ペインが今チャット表示か（利用者が自分で戻したら見張りをやめる）。 */
	isChatMode(instanceId: number): boolean;
	/** チャット表示へ戻す。 */
	returnToChat(instanceId: number): void;
}

/** 見張りを諦めるまでの時間（選択画面を開いたまま離れた場合）。 */
const WATCH_LIMIT_MS = 30 * 60 * 1000;

/**
 * 帯の「ターミナルを開く」から開いたペインだけを見張り、選択画面が消えたらチャット表示へ戻す。見出しの「ターミナルに戻る」で
 * 自分で切り替えたペインは見張らない（呼ばれないので）。
 */
export class ParadisAgentChatChoiceReturn extends Disposable {

	private readonly watches = this._register(new DisposableMap<number>());

	constructor(
		private readonly host: IParadisAgentChatChoiceReturnHost,
		private readonly intervalMs = 1000,
		private readonly limitMs = WATCH_LIMIT_MS,
	) {
		super();
	}

	/** 帯から開いた。選択画面が消えるまで見張る。 */
	watch(instanceId: number): void {
		const store = new DisposableStore();
		const startedAt = Date.now();
		const timer = store.add(new IntervalTimer());
		timer.cancelAndSet(() => {
			if (!this.host.exists(instanceId) || this.host.isChatMode(instanceId) || Date.now() - startedAt > this.limitMs) {
				this.watches.deleteAndDispose(instanceId);
				return;
			}
			if (!this.host.showsChoiceMenu(instanceId)) {
				this.watches.deleteAndDispose(instanceId);
				this.host.returnToChat(instanceId);
			}
		}, this.intervalMs);
		store.add(toDisposable(() => timer.cancel()));
		this.watches.set(instanceId, store);
	}

	/** 見張りをやめる（チャット表示を自分で開いた・閉じた）。 */
	cancel(instanceId: number): void {
		this.watches.deleteAndDispose(instanceId);
	}
}
