/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, IObservable, observableValue } from '../../../../base/common/observable.js';
import { IHostService } from '../../../../workbench/services/host/browser/host.js';

/** How long the window must stay unfocused before its polling is considered idle. */
const DEFAULT_IDLE_GRACE_MS = 60_000;

/**
 * Whether this window's GitHub polling should be running at all.
 *
 * Every open window polls on its own, so N open windows multiply the traffic by N —
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

/**
 * The activity of this window's {@link SessionGithubWindowActivity}, for pollers outside the
 * GitHub contribution (chat input banners, the archive nudge, the issue pills). Each renderer is one
 * window, so a module value is per window. It stays `true` until the contribution publishes, which
 * is how those pollers behaved before.
 */
const paradisWindowActive = observableValue<boolean>('paradisGithubWindowActive', true);

/** Shares the window activity the GitHub contribution tracks; see {@link paradisStartPollingWhileWindowActive}. */
export function paradisPublishGithubWindowActivity(isActive: IObservable<boolean>): IDisposable {
	const subscription = autorun(reader => paradisWindowActive.set(isActive.read(reader), undefined));
	return toDisposable(() => {
		subscription.dispose();
		paradisWindowActive.set(true, undefined);
	});
}

/** Polls `model` while this window is active, and stops while it sits in the background. */
export function paradisStartPollingWhileWindowActive(model: { startPolling(): IDisposable }): IDisposable {
	return autorun(reader => {
		if (paradisWindowActive.read(reader)) {
			reader.store.add(model.startPolling());
		}
	});
}
