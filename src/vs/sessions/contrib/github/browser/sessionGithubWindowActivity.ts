/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IObservable, observableValue } from '../../../../base/common/observable.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';

/** How long the window must stay unfocused before its polling is considered idle. */
const DEFAULT_IDLE_GRACE_MS = 60_000;

/**
 * Whether this window's GitHub polling should be running at all.
 *
 * The request gate is per window, so N open windows multiply every budget by N —
 * and a window nobody is looking at has no reason to keep an icon current. This
 * observable goes `false` once the window has been unfocused for a grace period
 * and back to `true` the moment it regains focus, so pollers can suspend while
 * the window is in the background and catch up on return.
 *
 * The grace period matters: alt-tabbing between two windows would otherwise
 * suspend and resume polling repeatedly, and each resume costs a refresh — the
 * opposite of what this is for.
 */
export class SessionGithubWindowActivity extends Disposable {

	private readonly _isActive = observableValue<boolean>(this, true);
	readonly isActive: IObservable<boolean> = this._isActive;

	private readonly _idleScheduler: RunOnceScheduler;

	constructor(
		hostService: IHostService,
		idleGraceMs: number = DEFAULT_IDLE_GRACE_MS,
	) {
		super();

		this._idleScheduler = this._register(new RunOnceScheduler(() => this._isActive.set(false, undefined), idleGraceMs));

		this._register(hostService.onDidChangeFocus(hasFocus => this._update(hasFocus)));
		this._update(hostService.hasFocus);
	}

	private _update(hasFocus: boolean): void {
		if (hasFocus) {
			this._idleScheduler.cancel();
			this._isActive.set(true, undefined);
			return;
		}

		if (this._isActive.get() && !this._idleScheduler.isScheduled()) {
			this._idleScheduler.schedule();
		}
	}
}
