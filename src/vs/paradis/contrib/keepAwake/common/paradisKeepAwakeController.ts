/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ParadisKeepAwakeBlockerMode } from './paradisKeepAwake.js';

type ActiveParadisKeepAwakeBlockerMode = Exclude<ParadisKeepAwakeBlockerMode, 'off'>;

export type ParadisKeepAwakeFailureOperation = 'blocker-start-failed' | 'blocker-stop-failed';

export interface IParadisKeepAwakeControllerOptions {
	start(mode: ActiveParadisKeepAwakeBlockerMode): Promise<number>;
	stop(id: number): Promise<void>;
	onDidChangeMode(mode: ParadisKeepAwakeBlockerMode): void;
	report(operation: ParadisKeepAwakeFailureOperation, error: unknown): void;
}

export class ParadisKeepAwakeController extends Disposable {

	private readonly blockers = new Map<number, ActiveParadisKeepAwakeBlockerMode>();
	private requestedMode: ParadisKeepAwakeBlockerMode = 'off';
	private _actualMode: ParadisKeepAwakeBlockerMode = 'off';
	private queue: Promise<void> = Promise.resolve();
	private disposing = false;

	get actualMode(): ParadisKeepAwakeBlockerMode {
		return this._actualMode;
	}

	constructor(private readonly options: IParadisKeepAwakeControllerOptions) {
		super();
	}

	setMode(mode: ParadisKeepAwakeBlockerMode): Promise<void> {
		if (!this.disposing) {
			this.requestedMode = mode;
		}
		return this.enqueue();
	}

	reconcile(): Promise<void> {
		return this.enqueue();
	}

	whenSettled(): Promise<void> {
		return this.queue;
	}

	private enqueue(): Promise<void> {
		const next = this.queue.then(() => this.reconcileNow());
		this.queue = next.catch(() => { });
		return next;
	}

	private async reconcileNow(): Promise<void> {
		for (; ;) {
			const requested = this.disposing ? 'off' : this.requestedMode;
			const hasRequested = requested !== 'off' &&
				[...this.blockers.values()].some(mode => mode === requested);

			if (requested !== 'off' && !hasRequested) {
				try {
					const id = await this.options.start(requested);
					this.blockers.set(id, requested);
					this.publishActualMode();
				} catch (error) {
					this.options.report('blocker-start-failed', error);
					return;
				}
				continue;
			}

			const stale = [...this.blockers].filter(([, mode]) => requested === 'off' || mode !== requested);
			if (stale.length === 0) {
				this.publishActualMode();
				return;
			}

			let stopFailed = false;
			for (const [id] of stale) {
				try {
					await this.options.stop(id);
					this.blockers.delete(id);
					this.publishActualMode();
				} catch (error) {
					this.options.report('blocker-stop-failed', error);
					this.publishActualMode();
					stopFailed = true;
					if (!this.disposing) {
						return;
					}
				}
			}
			if (stopFailed) {
				return;
			}
		}
	}

	private publishActualMode(): void {
		let actual: ParadisKeepAwakeBlockerMode = 'off';
		for (const mode of this.blockers.values()) {
			if (mode === 'display') {
				actual = 'display';
				break;
			}
			actual = 'system';
		}
		if (actual !== this._actualMode) {
			this._actualMode = actual;
			this.options.onDidChangeMode(actual);
		}
	}

	override dispose(): void {
		if (this.disposing) {
			return;
		}
		this.disposing = true;
		this.requestedMode = 'off';
		void this.enqueue();
		super.dispose();
	}
}
