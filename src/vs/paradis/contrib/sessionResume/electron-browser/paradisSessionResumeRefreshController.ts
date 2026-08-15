/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';

const AUTOMATIC_REFRESH_DELAY_MS = 750;

export interface IParadisSessionResumeRefreshScheduler extends IDisposable {
	schedule(delay: number): void;
	cancel(): void;
}

type SchedulerFactory = (runner: () => void) => IParadisSessionResumeRefreshScheduler;

export class ParadisSessionResumeRefreshController extends Disposable {
	private readonly scheduler: IParadisSessionResumeRefreshScheduler;
	private visible = true;
	private dirty = false;
	private running = false;
	private pendingImmediate = false;
	private pendingImmediateCompletion: Promise<void> | undefined;
	private pendingImmediateResolver: (() => void) | undefined;
	private activeImmediateResolver: (() => void) | undefined;
	private started = false;
	private automaticScheduled = false;
	private disposed = false;
	private generation = 0;

	constructor(
		private readonly run: () => Promise<void>,
		schedulerFactory: SchedulerFactory = runner => new RunOnceScheduler(runner, AUTOMATIC_REFRESH_DELAY_MS),
	) {
		super();
		this.scheduler = this._register(schedulerFactory(() => this.runAutomaticRefresh()));
	}

	start(): void {
		if (this.disposed || this.started) {
			return;
		}
		this.started = true;
		if (this.visible && this.dirty) {
			this.scheduleAutomaticRefresh(0);
		}
	}

	setVisible(visible: boolean): void {
		if (this.disposed || this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (!visible) {
			this.cancelAutomaticRefresh();
			return;
		}
		if (this.started && this.dirty && !this.running) {
			this.scheduleAutomaticRefresh(0);
		}
	}

	invalidate(): void {
		if (this.disposed) {
			return;
		}
		this.dirty = true;
		if (this.started && this.visible && !this.running) {
			this.scheduleAutomaticRefresh(AUTOMATIC_REFRESH_DELAY_MS);
		}
	}

	requestImmediate(): Promise<void> {
		const completion = this.getPendingImmediateCompletion();
		if (this.disposed) {
			this.resolvePendingImmediateRequests();
			return completion;
		}
		this.cancelAutomaticRefresh();
		if (!this.started) {
			this.dirty = true;
			return completion;
		}
		if (this.running) {
			this.pendingImmediate = true;
			return completion;
		}
		this.startRefresh();
		return completion;
	}

	private runAutomaticRefresh(): void {
		this.automaticScheduled = false;
		if (this.disposed || !this.started || !this.visible || this.running || !this.dirty) {
			return;
		}
		this.startRefresh();
	}

	private startRefresh(): void {
		if (this.disposed || this.running) {
			return;
		}
		this.dirty = false;
		this.running = true;
		this.activeImmediateResolver = this.pendingImmediateResolver;
		this.pendingImmediateCompletion = undefined;
		this.pendingImmediateResolver = undefined;
		const generation = this.generation;
		void this.completeRefresh(generation);
	}

	private async completeRefresh(generation: number): Promise<void> {
		try {
			await this.run();
		} catch {
			// The editor callback surfaces list failures and retains its existing sessions.
		}
		if (this.disposed || generation !== this.generation) {
			this.resolveActiveImmediateRequests();
			this.resolvePendingImmediateRequests();
			return;
		}
		this.running = false;
		this.resolveActiveImmediateRequests();
		if (!this.visible) {
			this.dirty ||= this.pendingImmediate;
			this.pendingImmediate = false;
			return;
		}
		if (this.pendingImmediate) {
			this.pendingImmediate = false;
			this.startRefresh();
			return;
		}
		if (this.dirty) {
			this.scheduleAutomaticRefresh(0);
		}
	}

	private scheduleAutomaticRefresh(delay: number): void {
		if (this.automaticScheduled) {
			return;
		}
		this.automaticScheduled = true;
		this.scheduler.schedule(delay);
	}

	private cancelAutomaticRefresh(): void {
		if (!this.automaticScheduled) {
			return;
		}
		this.automaticScheduled = false;
		this.scheduler.cancel();
	}

	private resolveActiveImmediateRequests(): void {
		this.activeImmediateResolver?.();
		this.activeImmediateResolver = undefined;
	}

	private resolvePendingImmediateRequests(): void {
		this.pendingImmediateResolver?.();
		this.pendingImmediateCompletion = undefined;
		this.pendingImmediateResolver = undefined;
	}

	private getPendingImmediateCompletion(): Promise<void> {
		if (!this.pendingImmediateCompletion) {
			this.pendingImmediateCompletion = new Promise<void>(resolve => this.pendingImmediateResolver = resolve);
		}
		return this.pendingImmediateCompletion;
	}

	override dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.generation++;
		this.cancelAutomaticRefresh();
		this.resolveActiveImmediateRequests();
		this.resolvePendingImmediateRequests();
		super.dispose();
	}
}
