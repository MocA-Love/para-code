/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisCdpInputDispatchResult } from '../common/paradisAgentBrowser.js';

const PARADIS_CDP_INPUT_QUEUE_LIMIT = 256;
/**
 * How long one dispatch may take before it is reported as outcome unknown. Covers the key suppression
 * acks (two round trips to the page's preload), the agent cursor glide and Chromium's input ack, which
 * waits for the page's main thread: a page busy for a few seconds after a click is normal.
 */
const PARADIS_CDP_INPUT_DISPATCH_TIMEOUT_MS = 10_000;
/**
 * A timed-out dispatch pauses its view until it settles. If it never settles, the pause ends after this
 * long and the stuck dispatch is abandoned (its late result is ignored), so one lost input cannot disable
 * a page until restart.
 */
const PARADIS_CDP_INPUT_POISON_RECOVERY_MS = 30_000;
const PARADIS_CDP_INPUT_POISONED_KEY_LIMIT = 4_096;
const PARADIS_CDP_INPUT_ACTIVE_KEY_LIMIT = 4_096;
const PARADIS_CDP_INPUT_QUEUE_KEY_MAX_LENGTH = 4_096;

/** Why a view's input was paused, and how the pause ended. Carries no page data. */
export type IParadisCdpInputQueueDiagnostic =
	| { readonly kind: 'paused'; readonly cause: 'dispatch-timeout' | 'connection-closed'; readonly method: string }
	| { readonly kind: 'resumed'; readonly how: 'settled' | 'recovery-timeout'; readonly cause: 'dispatch-timeout' | 'connection-closed'; readonly method: string; readonly pausedMs: number }
	| { readonly kind: 'saturated' };

export interface IParadisCdpInputQueueOptions {
	readonly dispatchTimeoutMs?: number;
	readonly poisonedKeyLimit?: number;
	readonly activeKeyLimit?: number;
	/** How long a pause may last when the dispatch that caused it never settles. */
	readonly poisonRecoveryMs?: number;
	/**
	 * Receives pauses and recoveries for the log and Sentry. Must not throw. `queueKey` names the paused
	 * view (absent for `saturated`), so the receiver can attribute it to a page.
	 */
	readonly onDiagnostic?: (event: IParadisCdpInputQueueDiagnostic, queueKey?: string) => void;
}

export interface IParadisCdpInputQueueRequest {
	readonly queueKey: string;
	/** CDP method, for diagnostics only. */
	readonly method?: string;
	readonly connection: object;
	readonly isAuthorityCurrent: () => boolean;
	readonly dispatch: () => Promise<IParadisCdpInputDispatchResult>;
}

export interface IParadisCdpInputQueueOperation {
	readonly response: Promise<IParadisCdpInputDispatchResult>;
	/** Resolves only when this command can no longer be overtaken by a later command. */
	readonly drained: Promise<void>;
}

interface IQueueEntry extends IParadisCdpInputQueueRequest {
	committed: boolean;
	cancelled: boolean;
	responseSettled: boolean;
	resolveResponse: (result: IParadisCdpInputDispatchResult) => void;
	resolveDrained: () => void;
	resolveRelease: () => void;
	readonly release: Promise<void>;
	/** The dispatch once committed, so a pause can end when it settles. */
	inflight?: Promise<unknown>;
}

interface IPoisonRecord {
	readonly cause: 'dispatch-timeout' | 'connection-closed';
	readonly method: string;
	readonly since: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const SAFE_METHOD = /^[A-Za-z]{1,40}\.[A-Za-z]{1,64}$/;

interface IKeyQueue {
	readonly entries: IQueueEntry[];
	running: boolean;
}

function retryable(message: string): IParadisCdpInputDispatchResult {
	return Object.freeze({ status: 'retryable', message: `PARA_BROWSER_RETRYABLE: ${message}` });
}

function outcomeUnknown(message: string): IParadisCdpInputDispatchResult {
	return Object.freeze({ status: 'outcome-unknown', message: `PARA_BROWSER_OUTCOME_UNKNOWN: ${message}` });
}

function pausedMessage(recoveryMs: number): IParadisCdpInputDispatchResult {
	return retryable(`browser input on this page is paused because an earlier input has not finished (the page may be busy); this input was not sent. Retry in a few seconds (the pause ends when that input finishes, or after ${Math.round(recoveryMs / 1000)}s at most)`);
}

function saturatedMessage(recoveryMs: number): IParadisCdpInputDispatchResult {
	return retryable(`browser input is paused on too many pages with unfinished input; this input was not sent. Retry in ${Math.round(recoveryMs / 1000)}s`);
}

/**
 * One ordered input queue per exact BrowserView identity.
 *
 * A dispatch that times out (or whose connection closes after it was sent) may still land later, so later
 * input to the same view must not overtake it: the view is paused. The pause ends as soon as that dispatch
 * settles, and at the latest after the recovery time, when the stuck dispatch is abandoned. Input that
 * arrives during a pause is not sent and is answered as retryable.
 */
export class ParadisCdpInputQueue implements IDisposable {
	private readonly queues = new Map<string, IKeyQueue>();
	private readonly poisonedQueueKeys = new Map<string, IPoisonRecord>();
	private readonly dispatchTimeoutMs: number;
	private readonly poisonedKeyLimit: number;
	private readonly activeKeyLimit: number;
	private readonly poisonRecoveryMs: number;
	private readonly onDiagnostic: ((event: IParadisCdpInputQueueDiagnostic, queueKey?: string) => void) | undefined;
	private poisonSaturated = false;
	private saturationTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(options: IParadisCdpInputQueueOptions = {}) {
		this.dispatchTimeoutMs = Number.isSafeInteger(options.dispatchTimeoutMs) && (options.dispatchTimeoutMs ?? 0) > 0
			? options.dispatchTimeoutMs!
			: PARADIS_CDP_INPUT_DISPATCH_TIMEOUT_MS;
		this.poisonedKeyLimit = Number.isSafeInteger(options.poisonedKeyLimit) && (options.poisonedKeyLimit ?? 0) > 0
			? Math.min(options.poisonedKeyLimit!, PARADIS_CDP_INPUT_POISONED_KEY_LIMIT)
			: PARADIS_CDP_INPUT_POISONED_KEY_LIMIT;
		this.activeKeyLimit = Number.isSafeInteger(options.activeKeyLimit) && (options.activeKeyLimit ?? 0) > 0
			? Math.min(options.activeKeyLimit!, PARADIS_CDP_INPUT_ACTIVE_KEY_LIMIT)
			: PARADIS_CDP_INPUT_ACTIVE_KEY_LIMIT;
		this.poisonRecoveryMs = Number.isSafeInteger(options.poisonRecoveryMs) && (options.poisonRecoveryMs ?? 0) > 0
			? options.poisonRecoveryMs!
			: PARADIS_CDP_INPUT_POISON_RECOVERY_MS;
		this.onDiagnostic = options.onDiagnostic;
	}

	enqueue(request: IParadisCdpInputQueueRequest): IParadisCdpInputQueueOperation {
		let resolveResponse!: (result: IParadisCdpInputDispatchResult) => void;
		let resolveDrained!: () => void;
		let resolveRelease!: () => void;
		const response = new Promise<IParadisCdpInputDispatchResult>(resolve => resolveResponse = resolve);
		const drained = new Promise<void>(resolve => resolveDrained = resolve);
		const release = new Promise<void>(resolve => resolveRelease = resolve);
		const operation = Object.freeze({ response, drained });

		if (this.disposed || typeof request.queueKey !== 'string' || request.queueKey.length === 0 || request.queueKey.length > PARADIS_CDP_INPUT_QUEUE_KEY_MAX_LENGTH) {
			resolveResponse(retryable('browser input queue is unavailable'));
			resolveDrained();
			return operation;
		}
		const paused = this.pausedResult(request.queueKey);
		if (paused) {
			resolveResponse(paused);
			resolveDrained();
			return operation;
		}

		let queue = this.queues.get(request.queueKey);
		if (!queue) {
			if (this.queues.size >= this.activeKeyLimit) {
				resolveResponse(retryable('browser input active descriptor capacity reached'));
				resolveDrained();
				return operation;
			}
			queue = { entries: [], running: false };
			this.queues.set(request.queueKey, queue);
		}
		if (queue.entries.length >= PARADIS_CDP_INPUT_QUEUE_LIMIT) {
			resolveResponse(retryable('browser input queue capacity reached'));
			resolveDrained();
			return operation;
		}

		queue.entries.push({
			...request,
			committed: false,
			cancelled: false,
			responseSettled: false,
			resolveResponse,
			resolveDrained,
			resolveRelease,
			release,
		});
		this.pump(request.queueKey, queue);
		return operation;
	}

	closeConnection(connection: object): void {
		for (const [queueKey, queue] of this.queues) {
			for (const entry of queue.entries) {
				if (entry.connection !== connection || entry.cancelled) {
					continue;
				}
				entry.cancelled = true;
				if (entry.committed) {
					this.poison(entry, 'connection-closed');
					this.settleResponse(entry, outcomeUnknown('browser input connection closed after dispatch'));
					entry.resolveRelease();
				} else {
					this.settleResponse(entry, retryable('browser input connection closed before dispatch'));
				}
			}
			this.pump(queueKey, queue);
		}
	}

	private pump(queueKey: string, queue: IKeyQueue): void {
		if (queue.running) {
			return;
		}
		while (queue.entries[0]?.cancelled && !queue.entries[0].committed) {
			const cancelled = queue.entries.shift()!;
			cancelled.resolveDrained();
		}
		const entry = queue.entries[0];
		if (!entry) {
			this.queues.delete(queueKey);
			return;
		}
		queue.running = true;
		void this.runEntry(entry).finally(() => {
			if (queue.entries[0] === entry) {
				queue.entries.shift();
			} else {
				const index = queue.entries.indexOf(entry);
				if (index >= 0) {
					queue.entries.splice(index, 1);
				}
			}
			entry.resolveDrained();
			queue.running = false;
			this.pump(queueKey, queue);
		});
	}

	private async runEntry(entry: IQueueEntry): Promise<void> {
		if (entry.cancelled) {
			return;
		}
		const paused = this.pausedResult(entry.queueKey);
		if (paused) {
			this.settleResponse(entry, paused);
			return;
		}
		let authorityCurrent: boolean;
		try {
			authorityCurrent = entry.isAuthorityCurrent();
		} catch {
			authorityCurrent = false;
		}
		if (!authorityCurrent) {
			this.settleResponse(entry, retryable('browser input authority changed before dispatch'));
			return;
		}

		entry.committed = true;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let dispatchPromise: Promise<IParadisCdpInputDispatchResult>;
		try {
			// Commit and invoke in one synchronous turn so close cannot land in a false post-commit gap.
			dispatchPromise = entry.dispatch();
		} catch (error) {
			dispatchPromise = Promise.reject(error);
		}
		entry.inflight = dispatchPromise;
		const timeoutPromise = new Promise<undefined>(resolve => {
			timeout = setTimeout(() => resolve(undefined), this.dispatchTimeoutMs);
		});
		const first = await Promise.race([
			dispatchPromise.then(result => ({ kind: 'completed' as const, result }), () => ({ kind: 'completed' as const, result: undefined })),
			timeoutPromise.then(() => ({ kind: 'timeout' as const, result: undefined })),
			entry.release.then(() => ({ kind: 'released' as const, result: undefined })),
		]);

		if (first.kind === 'timeout') {
			this.poison(entry, 'dispatch-timeout');
			this.settleResponse(entry, outcomeUnknown(`browser input dispatch timed out after ${this.dispatchTimeoutMs}ms`));
			return;
		}
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
		if (first.kind === 'released') {
			return;
		}
		if (entry.responseSettled) {
			return;
		}
		if (first.result === undefined) {
			this.settleResponse(entry, outcomeUnknown('browser input dispatch did not complete'));
			return;
		}
		if (first.result.status === 'retryable') {
			this.settleResponse(entry, first.result);
			return;
		}
		try {
			authorityCurrent = entry.isAuthorityCurrent();
		} catch {
			authorityCurrent = false;
		}
		this.settleResponse(entry, authorityCurrent
			? first.result
			: outcomeUnknown('browser input authority changed after dispatch'));
	}

	private settleResponse(entry: IQueueEntry, result: IParadisCdpInputDispatchResult): void {
		if (entry.responseSettled) {
			return;
		}
		entry.responseSettled = true;
		entry.resolveResponse(result);
	}

	private pausedResult(queueKey: string): IParadisCdpInputDispatchResult | undefined {
		if (this.poisonSaturated) {
			return saturatedMessage(this.poisonRecoveryMs);
		}
		return this.poisonedQueueKeys.has(queueKey) ? pausedMessage(this.poisonRecoveryMs) : undefined;
	}

	private poison(entry: IQueueEntry, cause: IPoisonRecord['cause']): void {
		const queueKey = entry.queueKey;
		if (this.disposed || this.poisonedQueueKeys.has(queueKey)) {
			return;
		}
		if (this.poisonedQueueKeys.size >= this.poisonedKeyLimit) {
			// Too many views paused at once: pause all input for one recovery period instead of forever.
			if (!this.poisonSaturated) {
				this.poisonSaturated = true;
				this.emit({ kind: 'saturated' });
				this.saturationTimer = setTimeout(() => {
					this.saturationTimer = undefined;
					this.poisonSaturated = false;
				}, this.poisonRecoveryMs);
			}
			return;
		}
		const record: IPoisonRecord = {
			cause,
			method: typeof entry.method === 'string' && SAFE_METHOD.test(entry.method) ? entry.method : 'unknown',
			since: Date.now(),
			timer: undefined,
		};
		this.poisonedQueueKeys.set(queueKey, record);
		this.emit({ kind: 'paused', cause, method: record.method }, queueKey);
		record.timer = setTimeout(() => this.resume(queueKey, record, 'recovery-timeout'), this.poisonRecoveryMs);
		// The late answer itself is ignored (the caller was already told the outcome is unknown); it only
		// proves nothing from that input is still on its way, so later input can no longer overtake it.
		entry.inflight?.then(() => this.resume(queueKey, record, 'settled'), () => this.resume(queueKey, record, 'settled'));
	}

	private resume(queueKey: string, record: IPoisonRecord, how: 'settled' | 'recovery-timeout'): void {
		if (this.poisonedQueueKeys.get(queueKey) !== record) {
			return;
		}
		if (record.timer !== undefined) {
			clearTimeout(record.timer);
			record.timer = undefined;
		}
		this.poisonedQueueKeys.delete(queueKey);
		if (!this.disposed) {
			this.emit({ kind: 'resumed', how, cause: record.cause, method: record.method, pausedMs: Math.max(0, Date.now() - record.since) }, queueKey);
		}
	}

	private emit(event: IParadisCdpInputQueueDiagnostic, queueKey?: string): void {
		try {
			this.onDiagnostic?.(event, queueKey);
		} catch {
			// Diagnostics must never change input ordering.
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const record of this.poisonedQueueKeys.values()) {
			if (record.timer !== undefined) {
				clearTimeout(record.timer);
				record.timer = undefined;
			}
		}
		this.poisonedQueueKeys.clear();
		if (this.saturationTimer !== undefined) {
			clearTimeout(this.saturationTimer);
			this.saturationTimer = undefined;
		}
		for (const queue of this.queues.values()) {
			for (const entry of queue.entries) {
				entry.cancelled = true;
				if (entry.committed) {
					this.settleResponse(entry, outcomeUnknown('browser input queue disposed after dispatch'));
					entry.resolveRelease();
				} else {
					this.settleResponse(entry, retryable('browser input queue disposed before dispatch'));
				}
			}
		}
	}
}
