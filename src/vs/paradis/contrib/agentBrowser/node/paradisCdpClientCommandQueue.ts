/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type * as wsTypes from 'ws';

/**
 * CDP プロキシ（paradisCdpFilterProxy.ts）がクライアントの命令を順に処理する列。ページの経路とブラウザの経路が使う。
 *
 * 命令は列の鍵（ブラウザの経路はセッション、ページの経路は 1 つ）ごとに、届いた順に処理する。待つ命令（URL の確かめ・移動の
 * 応答待ち・入力の順番待ち）があっても、ほかの鍵の命令は待たせない。前の命令が終わっていなければ、待っている命令の数と
 * バイト数を数え、上限を超える命令が来たら受け付けない（呼ぶ側は接続を閉じる）。処理が投げたら `fail` を呼ぶ。
 */
export class ParadisCdpClientCommandQueue {

	private scheduledMessages = 0;
	private scheduledBytes = 0;
	/** 鍵ごとの、処理中の命令の列の最後。 */
	private readonly tails = new Map<string, Promise<void>>();

	constructor(
		private readonly process: (data: wsTypes.RawData) => Promise<void> | undefined,
		private readonly fail: () => void,
		private readonly maxMessages: number,
		private readonly maxBytes: number,
	) { }

	/** 待っている命令に `bytes` を足すと上限を超えるか。 */
	isFull(bytes: number): boolean {
		return this.scheduledMessages >= this.maxMessages || this.scheduledBytes + bytes > this.maxBytes;
	}

	/** 1 つの命令を `key` の列へ入れる（前が無ければすぐ処理する）。上限は先に {@link isFull} で確かめておく。 */
	enqueue(data: wsTypes.RawData, bytes: number, key: string): void {
		const previous = this.tails.get(key);
		if (!previous) {
			try {
				const wait = this.process(data);
				if (wait) {
					const guarded = wait.catch(this.fail);
					this.tails.set(key, guarded);
					void guarded.finally(() => {
						if (this.tails.get(key) === guarded) {
							this.tails.delete(key);
						}
					});
				}
			} catch {
				this.fail();
			}
			return;
		}
		this.scheduledMessages++;
		this.scheduledBytes += bytes;
		const next = previous
			.then(() => this.process(data))
			.catch(this.fail)
			.finally(() => {
				this.scheduledMessages = Math.max(0, this.scheduledMessages - 1);
				this.scheduledBytes = Math.max(0, this.scheduledBytes - bytes);
			});
		this.tails.set(key, next);
		void next.finally(() => {
			if (this.tails.get(key) === next) {
				this.tails.delete(key);
			}
		});
	}
}
