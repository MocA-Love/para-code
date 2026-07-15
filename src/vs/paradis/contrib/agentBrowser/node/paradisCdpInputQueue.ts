/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IParadisCdpInputDispatchResult } from '../common/paradisAgentBrowser.js';

const PARADIS_CDP_INPUT_QUEUE_LIMIT = 256;
const PARADIS_CDP_INPUT_DISPATCH_TIMEOUT_MS = 5_000;
const PARADIS_CDP_INPUT_POISONED_KEY_LIMIT = 4_096;
const PARADIS_CDP_INPUT_ACTIVE_KEY_LIMIT = 4_096;
const PARADIS_CDP_INPUT_QUEUE_KEY_MAX_LENGTH = 4_096;

export interface IParadisCdpInputQueueOptions {
	readonly dispatchTimeoutMs?: number;
	readonly poisonedKeyLimit?: number;
	readonly activeKeyLimit?: number;
}

export interface IParadisCdpInputQueueRequest {
	readonly queueKey: string;
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
}

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

/** One ordered input queue per exact BrowserView identity. */
export class ParadisCdpInputQueue implements IDisposable {
	private readonly queues = new Map<string, IKeyQueue>();
	private readonly poisonedQueueKeys = new Set<string>();
	private readonly dispatchTimeoutMs: number;
	private readonly poisonedKeyLimit: number;
	private readonly activeKeyLimit: number;
	private poisonSaturated = false;
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
		if (this.poisonSaturated || this.poisonedQueueKeys.has(request.queueKey)) {
			resolveResponse(outcomeUnknown(this.poisonSaturated
				? 'browser input queue poison capacity reached; input is disabled until restart'
				: 'exact BrowserView input queue is poisoned by an unresolved dispatch'));
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
					this.poison(entry.queueKey);
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
		if (this.poisonSaturated || this.poisonedQueueKeys.has(entry.queueKey)) {
			this.settleResponse(entry, outcomeUnknown(this.poisonSaturated
				? 'browser input queue poison capacity reached; input is disabled until restart'
				: 'exact BrowserView input queue is poisoned by an unresolved dispatch'));
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
		const timeoutPromise = new Promise<undefined>(resolve => {
			timeout = setTimeout(() => resolve(undefined), this.dispatchTimeoutMs);
		});
		const first = await Promise.race([
			dispatchPromise.then(result => ({ kind: 'completed' as const, result }), () => ({ kind: 'completed' as const, result: undefined })),
			timeoutPromise.then(() => ({ kind: 'timeout' as const, result: undefined })),
			entry.release.then(() => ({ kind: 'released' as const, result: undefined })),
		]);

		if (first.kind === 'timeout') {
			this.poison(entry.queueKey);
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

	private poison(queueKey: string): void {
		if (this.poisonSaturated || this.poisonedQueueKeys.has(queueKey)) {
			return;
		}
		if (this.poisonedQueueKeys.size >= this.poisonedKeyLimit) {
			this.poisonSaturated = true;
			return;
		}
		this.poisonedQueueKeys.add(queueKey);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const queue of this.queues.values()) {
			for (const entry of queue.entries) {
				entry.cancelled = true;
				if (entry.committed) {
					this.poison(entry.queueKey);
					this.settleResponse(entry, outcomeUnknown('browser input queue disposed after dispatch'));
					entry.resolveRelease();
				} else {
					this.settleResponse(entry, retryable('browser input queue disposed before dispatch'));
				}
			}
		}
	}
}
