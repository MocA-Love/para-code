/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * ディレクトリ走査の時刻を、TTLと件数上限の範囲だけ保持する。
 * 参照・記録時に同期的に整理するため、timerは所有しない。
 * ttlMsは正の有限値、limitは正の整数を呼び出し側が渡す契約とする。
 */
export class ParadisDirectoryWalkLedger {
	private readonly entries = new Map<string, number>();

	constructor(
		private readonly ttlMs: number,
		private readonly limit: number,
		private readonly now: () => number = Date.now,
	) { }

	mayRun(key: string): boolean {
		const now = this.now();
		this.prune(now);
		const last = this.entries.get(key);
		return last === undefined || now - last >= this.ttlMs;
	}

	mark(key: string): void {
		const now = this.now();
		this.prune(now);
		this.entries.delete(key);
		this.entries.set(key, now);
		while (this.entries.size > this.limit && this.entries.size > 0) {
			this.entries.delete(this.entries.keys().next().value!);
		}
	}

	/** 保持上限を決定的に検証するための件数。 */
	get size(): number {
		return this.entries.size;
	}

	private prune(now: number): void {
		for (const [key, at] of this.entries) {
			if (now - at >= this.ttlMs) {
				this.entries.delete(key);
			}
		}
	}
}
