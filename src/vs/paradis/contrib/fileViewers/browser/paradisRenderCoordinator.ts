/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';

interface RenderWaiter {
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

/**
 * Ensures that only one render runs at a time. Requests received while a render is active are
 * coalesced into one follow-up render so that bursts of file/configuration events cannot race.
 */
export class ParadisRenderCoordinator extends Disposable {

	private _pending: RenderWaiter[] | undefined;
	private _active: RenderWaiter[] | undefined;
	private _draining = false;
	private _disposed = false;

	constructor(private readonly _render: () => Promise<void>) {
		super();
	}

	request(): Promise<void> {
		if (this._disposed) {
			return Promise.reject(new CancellationError());
		}

		const result = new Promise<void>((resolve, reject) => {
			(this._pending ??= []).push({ resolve, reject });
		});
		if (!this._draining) {
			this._draining = true;
			void this._drain();
		}
		return result;
	}

	private async _drain(): Promise<void> {
		try {
			while (!this._disposed && this._pending) {
				const waiters = this._pending;
				this._pending = undefined;
				this._active = waiters;
				try {
					await this._render();
					if (this._disposed) {
						this._reject(waiters, new CancellationError());
					} else {
						for (const waiter of waiters) {
							waiter.resolve();
						}
					}
				} catch (error) {
					this._reject(waiters, error);
				} finally {
					this._active = undefined;
				}
			}
		} finally {
			this._draining = false;
			if (!this._disposed && this._pending) {
				this._draining = true;
				void this._drain();
			}
		}
	}

	private _reject(waiters: readonly RenderWaiter[], error: unknown): void {
		for (const waiter of waiters) {
			waiter.reject(error);
		}
	}

	override dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		const cancellationError = new CancellationError();
		if (this._pending) {
			this._reject(this._pending, cancellationError);
			this._pending = undefined;
		}
		if (this._active) {
			this._reject(this._active, cancellationError);
			this._active = undefined;
		}
		super.dispose();
	}
}

/** Runs an operation up to `maxAttempts` times and rethrows its final error. */
export async function runParadisRenderWithRetries<T>(
	maxAttempts: number,
	operation: (attempt: number) => Promise<T>,
	shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
		throw new RangeError('maxAttempts must be a positive integer');
	}

	for (let attempt = 1; ; attempt++) {
		try {
			return await operation(attempt);
		} catch (error) {
			if (attempt >= maxAttempts || !shouldRetry(error)) {
				throw error;
			}
		}
	}
}
