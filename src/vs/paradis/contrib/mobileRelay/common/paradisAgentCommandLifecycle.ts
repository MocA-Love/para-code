/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type ParadisAgentCommandDeliveryResult = 'accepted' | 'stale' | 'ambiguous';

export interface IParadisAgentCommandTimer {
	set(callback: () => void, delayMs: number): unknown;
	clear(handle: unknown): void;
}

interface IParadisAgentCommandDeliveryState {
	readonly token: string;
	readonly commandLine: string;
	readonly generation: number;
	readonly notifyStart: (generation: number) => Promise<ParadisAgentCommandDeliveryResult>;
	notifyFinish?: (generation: number) => Promise<ParadisAgentCommandDeliveryResult>;
	phase: 'starting' | 'running' | 'finishing' | 'finished';
	startAccepted: boolean;
	finishAccepted: boolean;
	retryHandle?: unknown;
	cancelInFlight?: () => void;
}

export interface IParadisAgentCommandDeliveryCoordinatorOptions {
	readonly timer?: IParadisAgentCommandTimer;
	readonly retryDelayMs?: number;
	readonly operationTimeoutMs?: number;
	readonly syncRegistry: (token: string) => Promise<void>;
	readonly onProvisionalChange: (token: string, active: boolean, generation: number) => void;
	readonly onGenerationEnded: (token: string, generation: number) => void;
}

const defaultTimer: IParadisAgentCommandTimer = {
	set: (callback, delayMs) => setTimeout(callback, delayMs),
	clear: handle => globalThis.clearTimeout(handle as number),
};

/**
 * Renderer側のcommand deliveryをpane tokenごとに直列化する。
 * registry同期→通知の順序、世代単位のretry、accepted後だけのdedupeを一箇所で保証する。
 */
export class ParadisAgentCommandDeliveryCoordinator {
	private static readonly MAX_GENERATION_ENTRIES = 4_096;
	private readonly states = new Map<string, IParadisAgentCommandDeliveryState>();
	private readonly generations = new Map<string, number>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly timer: IParadisAgentCommandTimer;
	private readonly retryDelayMs: number;
	private readonly operationTimeoutMs: number;
	private disposed = false;

	constructor(private readonly options: IParadisAgentCommandDeliveryCoordinatorOptions) {
		this.timer = options.timer ?? defaultTimer;
		this.retryDelayMs = options.retryDelayMs ?? 1_000;
		this.operationTimeoutMs = options.operationTimeoutMs ?? 15_000;
	}

	/** 長時間sessionでtoken履歴が無制限に増えないことを検証する計測値。 */
	get generationEntryCount(): number { return this.generations.size; }
	/** supersede/timeout後にtoken queueが解放されることを検証する計測値。 */
	get queuedTokenCount(): number { return this.queues.size; }

	/** 現在tokenへ連結済みの処理がなくなるまで待つ。テストと明示的なflushに使用する。 */
	async whenIdle(token: string): Promise<void> {
		while (true) {
			const pending = this.queues.get(token);
			if (pending === undefined) {
				return;
			}
			await pending;
		}
	}

	start(token: string, commandLine: string, notify: (generation: number) => Promise<ParadisAgentCommandDeliveryResult>): void {
		if (this.disposed) {
			return;
		}
		const current = this.states.get(token);
		if (current?.commandLine === commandLine && (current.phase === 'starting' || current.phase === 'running')) {
			return;
		}
		if (current !== undefined) {
			this.cancelRetry(current);
			current.cancelInFlight?.();
			if (current.phase !== 'finished' && current.phase !== 'finishing') {
				this.options.onGenerationEnded(token, current.generation);
			}
		}
		const generation = (current?.generation ?? this.generations.get(token) ?? 0) + 1;
		this.generations.delete(token);
		const state: IParadisAgentCommandDeliveryState = {
			token,
			commandLine,
			generation,
			notifyStart: notify,
			phase: 'starting',
			startAccepted: false,
			finishAccepted: false,
		};
		this.states.set(token, state);
		this.options.onProvisionalChange(token, true, generation);
		this.enqueue(state);
	}

	finish(token: string, commandLine: string, notify: (generation: number) => Promise<ParadisAgentCommandDeliveryResult>): void {
		const state = this.states.get(token);
		if (this.disposed || state === undefined || state.commandLine !== commandLine || state.phase === 'finishing' || state.phase === 'finished') {
			return;
		}
		state.phase = 'finishing';
		state.notifyFinish = notify;
		this.cancelRetry(state);
		this.options.onProvisionalChange(token, false, state.generation);
		this.options.onGenerationEnded(token, state.generation);
		this.enqueue(state);
	}

	disposeToken(token: string): void {
		const state = this.states.get(token);
		if (state === undefined) {
			return;
		}
		this.cancelRetry(state);
		state.cancelInFlight?.();
		this.states.delete(token);
		this.generations.delete(token);
		this.generations.set(token, state.generation);
		this.pruneGenerationHistory();
		if (state.phase === 'starting' || state.phase === 'running') {
			this.options.onProvisionalChange(token, false, state.generation);
			this.options.onGenerationEnded(token, state.generation);
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		for (const token of [...this.states.keys()]) {
			this.disposeToken(token);
		}
		this.queues.clear();
	}

	private enqueue(state: IParadisAgentCommandDeliveryState): void {
		const previous = this.queues.get(state.token) ?? Promise.resolve();
		const next = previous.then(() => this.deliver(state), () => this.deliver(state));
		this.queues.set(state.token, next);
		void next.then(() => {
			if (this.queues.get(state.token) === next) {
				this.queues.delete(state.token);
			}
		});
	}

	private async deliver(state: IParadisAgentCommandDeliveryState): Promise<void> {
		if (!this.isCurrent(state)) {
			return;
		}
		this.cancelRetry(state);
		if (!state.startAccepted) {
			const result = await this.deliverOperation(state, state.notifyStart);
			if (!this.isCurrent(state)) {
				return;
			}
			if (result !== 'accepted') {
				this.scheduleRetry(state);
				return;
			}
			state.startAccepted = true;
			if (state.phase === 'starting') {
				state.phase = 'running';
			}
		}
		if (state.phase !== 'finishing' || state.finishAccepted || state.notifyFinish === undefined) {
			return;
		}
		const result = await this.deliverOperation(state, state.notifyFinish);
		if (!this.isCurrent(state)) {
			return;
		}
		if (result !== 'accepted') {
			this.scheduleRetry(state);
			return;
		}
		state.finishAccepted = true;
		state.phase = 'finished';
	}

	private async deliverOperation(state: IParadisAgentCommandDeliveryState, notify: (generation: number) => Promise<ParadisAgentCommandDeliveryResult>): Promise<ParadisAgentCommandDeliveryResult | undefined> {
		let cancel!: () => void;
		const canceled = new Promise<undefined>(resolve => {
			cancel = () => resolve(undefined);
		});
		state.cancelInFlight = cancel;
		let timeoutHandle: unknown;
		const timedOut = new Promise<undefined>(resolve => {
			timeoutHandle = this.timer.set(() => resolve(undefined), this.operationTimeoutMs);
		});
		const operation = (async (): Promise<ParadisAgentCommandDeliveryResult | undefined> => {
			try {
				await this.options.syncRegistry(state.token);
				if (!this.isCurrent(state)) {
					return undefined;
				}
				return await notify(state.generation);
			} catch {
				return undefined;
			}
		})();
		try {
			return await Promise.race([operation, canceled, timedOut]);
		} finally {
			this.timer.clear(timeoutHandle);
			if (state.cancelInFlight === cancel) {
				state.cancelInFlight = undefined;
			}
		}
	}

	private scheduleRetry(state: IParadisAgentCommandDeliveryState): void {
		if (!this.isCurrent(state) || state.retryHandle !== undefined) {
			return;
		}
		state.retryHandle = this.timer.set(() => {
			state.retryHandle = undefined;
			if (this.isCurrent(state)) {
				this.enqueue(state);
			}
		}, this.retryDelayMs);
	}

	private cancelRetry(state: IParadisAgentCommandDeliveryState): void {
		if (state.retryHandle === undefined) {
			return;
		}
		this.timer.clear(state.retryHandle);
		state.retryHandle = undefined;
	}

	private isCurrent(state: IParadisAgentCommandDeliveryState): boolean {
		return !this.disposed && this.states.get(state.token) === state;
	}

	private pruneGenerationHistory(): void {
		while (this.generations.size > ParadisAgentCommandDeliveryCoordinator.MAX_GENERATION_ENTRIES) {
			const oldestRetiredToken = this.generations.keys().next().value;
			if (oldestRetiredToken === undefined) {
				return;
			}
			this.generations.delete(oldestRetiredToken);
		}
	}
}

interface IParadisAgentCommandAuthorityState {
	readonly owner: string;
	readonly generation: number;
	readonly commandLine: string;
	finished: boolean;
}

export interface IParadisAgentCommandAuthorityDecision {
	readonly result: Exclude<ParadisAgentCommandDeliveryResult, 'ambiguous'>;
	readonly apply: boolean;
}

/** Shared process側でrenderer再送をidempotentにし、旧世代finishを拒否するauthority。 */
export class ParadisAgentCommandAuthority {
	private readonly states = new Map<string, IParadisAgentCommandAuthorityState>();

	start(owner: string, token: string, generation: number, commandLine: string): IParadisAgentCommandAuthorityDecision {
		if (!Number.isSafeInteger(generation) || generation <= 0 || commandLine.length === 0 || commandLine.length > 100_000) {
			return { result: 'stale', apply: false };
		}
		const current = this.states.get(token);
		if (current !== undefined && current.owner === owner) {
			if (generation < current.generation || (generation === current.generation && current.commandLine !== commandLine)) {
				return { result: 'stale', apply: false };
			}
			if (generation === current.generation) {
				return { result: 'accepted', apply: false };
			}
		}
		this.states.set(token, { owner, generation, commandLine, finished: false });
		return { result: 'accepted', apply: true };
	}

	finish(owner: string, token: string, generation: number): IParadisAgentCommandAuthorityDecision {
		if (!Number.isSafeInteger(generation) || generation <= 0) {
			return { result: 'stale', apply: false };
		}
		const current = this.states.get(token);
		if (current === undefined || current.owner !== owner || current.generation !== generation) {
			return { result: 'stale', apply: false };
		}
		if (current.finished) {
			return { result: 'accepted', apply: false };
		}
		current.finished = true;
		return { result: 'accepted', apply: true };
	}

	retain(owner: string, tokens: ReadonlySet<string>): void {
		for (const [token, state] of this.states) {
			if (state.owner === owner && !tokens.has(token)) {
				this.states.delete(token);
			}
		}
	}
}

/** detach済み旧instanceのdisposeで、reattach先のtoken stateを退役させない。 */
export function paradisShouldRetireAgentToken(disposedInstanceId: number, currentReverseOwnerInstanceId: number | undefined): boolean {
	return currentReverseOwnerInstanceId === undefined || currentReverseOwnerInstanceId === disposedInstanceId;
}
