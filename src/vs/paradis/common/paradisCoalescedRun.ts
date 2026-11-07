/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 1 本ずつ走らせる処理。走っている間に来た依頼は、終わった後の 1 回にまとめる（並べて走らせると、遅い回の古い
 * 結果が後から新しい結果を上書きする）。`run` は失敗しても次へ進めるよう、自分で例外を飲むこと。
 */
export class ParadisCoalescedRun {

	private running: Promise<void> | undefined;
	private queued: Promise<void> | undefined;

	constructor(private readonly run: () => Promise<void>) { }

	/** 走らせる。走っている間なら、終わった後に 1 回だけ走らせ、その回が済むまで待つ。 */
	trigger(): Promise<void> {
		if (this.running) {
			this.queued ??= this.running.then(() => {
				this.queued = undefined;
				return this.trigger();
			});
			return this.queued;
		}
		this.running = this.run().finally(() => this.running = undefined);
		return this.running;
	}
}
