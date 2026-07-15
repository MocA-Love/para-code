/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IParadisPaneBinding } from './paradisAgentBrowser.js';

/** BrowserView台帳から消滅したページのバインディングだけを返す。 */
export function paradisBindingsForMissingPages(
	bindings: readonly IParadisPaneBinding[],
	livePageIds: ReadonlySet<string>,
): IParadisPaneBinding[] {
	return bindings.filter(binding => !livePageIds.has(binding.pageId));
}

/** 観測時と現在のバインディング世代が厳密に一致するかを返す。 */
export function paradisBindingMatchesGeneration(
	binding: { readonly generation: number } | undefined,
	expectedGeneration: number,
): boolean {
	return binding?.generation === expectedGeneration;
}

/** 既知BrowserView IDの集合から1件でも消滅したかを返す。 */
export function paradisBrowserViewIdsWereRemoved(
	previousIds: ReadonlySet<string>,
	currentIds: ReadonlySet<string>,
): boolean {
	for (const id of previousIds) {
		if (!currentIds.has(id)) {
			return true;
		}
	}
	return false;
}

export interface IParadisRemovedBrowserBindingReconcilerOptions {
	readonly now?: () => number;
	readonly getLivePageIds: () => ReadonlySet<string>;
	readonly listBindings: () => Promise<readonly IParadisPaneBinding[]>;
	readonly unbindIfCurrent: (token: string, generation: number) => Promise<boolean>;
}

interface IParadisRemovedBindingCandidate {
	readonly token: string;
	readonly pageId: string;
	readonly expectedGeneration: number;
}

interface IParadisBrowserRemovalRecord {
	readonly observedAt: number;
	snapshotEstablished: boolean;
	readonly candidates: Map<string, IParadisRemovedBindingCandidate>;
}

/**
 * known BrowserView台帳で実際に削除を観測したpageだけを、generation条件付きで解除する。
 * stale(false)はそのcandidateの完了確認とし、一時的なIPC例外だけを同じ
 * expectedGenerationのpendingに残す。binding消滅の確認またはBrowserView再追加まで再試行する。
 */
export class ParadisRemovedBrowserBindingReconciler {

	private _knownPageIds: Set<string>;
	private readonly _removals = new Map<string, IParadisBrowserRemovalRecord>();
	private _disposed = false;

	constructor(
		initialKnownPageIds: ReadonlySet<string>,
		private readonly options: IParadisRemovedBrowserBindingReconcilerOptions,
	) {
		this._knownPageIds = new Set(initialKnownPageIds);
	}

	get hasPendingRemovals(): boolean {
		return !this._disposed && this._removals.size > 0;
	}

	observeKnownPageIds(currentPageIds: ReadonlySet<string>): boolean {
		if (this._disposed) {
			return false;
		}
		let removed = false;
		for (const id of this._knownPageIds) {
			if (!currentPageIds.has(id) && !this._removals.has(id)) {
				this._removals.set(id, {
					observedAt: this.options.now?.() ?? Date.now(),
					snapshotEstablished: false,
					candidates: new Map(),
				});
				removed = true;
			}
		}
		// 復元/再追加されたpageは、未実行の解除対象から即時除外する。
		for (const id of currentPageIds) {
			this._removals.delete(id);
		}
		this._knownPageIds = new Set(currentPageIds);
		return removed;
	}

	async reconcile(): Promise<boolean> {
		if (!this.hasPendingRemovals) {
			return false;
		}
		const targetRemovals = [...this._removals.entries()];
		let bindings: readonly IParadisPaneBinding[];
		try {
			bindings = await this.options.listBindings();
		} catch {
			return this.hasPendingRemovals;
		}
		if (this._disposed) {
			return false;
		}

		// 最初に成功したbinding snapshotで削除観測以前のcohortを1回だけ固定する。
		// その後のrebindや新generationは後続listから昇格させない。
		for (const [pageId, record] of targetRemovals) {
			if (this._removals.get(pageId) !== record) {
				continue;
			}
			if (!record.snapshotEstablished) {
				for (const binding of bindings) {
					// 同一msで削除後にrebindされた可能性も新世代保護を優先する。
					// 厳密に観測時刻より前のbindingだけをcohortに入れる。
					if (binding.pageId === pageId && binding.boundAt < record.observedAt) {
						record.candidates.set(binding.token, {
							token: binding.token,
							pageId,
							expectedGeneration: binding.generation,
						});
					}
				}
				record.snapshotEstablished = true;
			} else {
				// 前回例外後でも、元generationが既に消えていれば候補を完了する。
				for (const [token, candidate] of record.candidates) {
					if (!paradisBindingsContainCandidate(bindings, candidate)) {
						record.candidates.delete(token);
					}
				}
			}
			if (record.candidates.size === 0) {
				this._removals.delete(pageId);
			}
		}

		let needsPostFetch = false;
		for (const [pageId, record] of targetRemovals) {
			if (this._removals.get(pageId) !== record) {
				continue;
			}
			for (const [token, candidate] of [...record.candidates]) {
				if (this._removals.get(pageId) !== record) {
					break;
				}
				let livePageIds: ReadonlySet<string>;
				try {
					livePageIds = this.options.getLivePageIds();
				} catch {
					return this.hasPendingRemovals;
				}
				// IPC直前にもknown台帳を再確認し、復元済みpageに触れない。
				if (livePageIds.has(pageId)) {
					this._removals.delete(pageId);
					break;
				}
				if (this._disposed) {
					return false;
				}
				try {
					await this.options.unbindIfCurrent(candidate.token, candidate.expectedGeneration);
					// trueは解除完了、falseは元generationがstaleである確認。
					// どちらも候補は完了し、新generationを昇格させない。
					record.candidates.delete(token);
				} catch {
					// 一時失敗は同じexpectedGenerationのまま次回再試行する。
					needsPostFetch = true;
				}
				if (this._disposed) {
					return false;
				}
			}
			if (record.candidates.size === 0 && this._removals.get(pageId) === record) {
				this._removals.delete(pageId);
			}
		}

		if (!needsPostFetch) {
			return this.hasPendingRemovals;
		}
		let remainingBindings: readonly IParadisPaneBinding[];
		try {
			remainingBindings = await this.options.listBindings();
		} catch {
			return this.hasPendingRemovals;
		}
		if (this._disposed) {
			return false;
		}
		for (const [pageId, record] of targetRemovals) {
			if (this._removals.get(pageId) !== record) {
				continue;
			}
			let livePageIds: ReadonlySet<string>;
			try {
				livePageIds = this.options.getLivePageIds();
			} catch {
				return this.hasPendingRemovals;
			}
			if (livePageIds.has(pageId)) {
				this._removals.delete(pageId);
				continue;
			}
			for (const [token, candidate] of record.candidates) {
				if (!paradisBindingsContainCandidate(remainingBindings, candidate)) {
					record.candidates.delete(token);
				}
			}
			if (record.candidates.size === 0) {
				this._removals.delete(pageId);
			}
		}
		return this.hasPendingRemovals;
	}

	dispose(): void {
		this._disposed = true;
		this._removals.clear();
	}
}

function paradisBindingsContainCandidate(
	bindings: readonly IParadisPaneBinding[],
	candidate: IParadisRemovedBindingCandidate,
): boolean {
	return bindings.some(binding => binding.token === candidate.token
		&& binding.pageId === candidate.pageId
		&& binding.generation === candidate.expectedGeneration);
}

/**
 * async reconciliationを1本ずつ実行し、実行中の要求を1回の追加実行へ集約する。
 * operationの失敗は後続reconciliationを止めず、呼び出し元へunhandled rejectionを残さない。
 */
export class ParadisSerializedReconciler {

	private _running = false;
	private _pending = false;
	private _disposed = false;
	private readonly _idleWaiters = new Set<() => void>();

	constructor(
		private readonly operation: () => Promise<void>,
		private readonly onError?: (error: unknown) => void,
	) { }

	request(): Promise<void> {
		if (this._disposed) {
			return Promise.resolve();
		}
		this._pending = true;
		const idle = new Promise<void>(resolve => {
			this._idleWaiters.add(resolve);
		});
		if (!this._running) {
			this._running = true;
			void this._drain();
		}
		return idle;
	}

	dispose(): void {
		this._disposed = true;
		this._pending = false;
	}

	private async _drain(): Promise<void> {
		while (!this._disposed && this._pending) {
			this._pending = false;
			try {
				await this.operation();
			} catch (error) {
				try {
					this.onError?.(error);
				} catch {
					// エラー通知自体の失敗もreconciliationを停止させない。
				}
			}
		}
		// awaitのない単一の完了境界でidle化してからwaiterを解放する。
		// この後のmicrotaskから来たrequestは新しいdrainを必ず起動する。
		this._running = false;
		const waiters = [...this._idleWaiters];
		this._idleWaiters.clear();
		for (const resolve of waiters) {
			resolve();
		}
	}
}
