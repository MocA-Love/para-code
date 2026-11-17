/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';
import { paradisCollectAllTerminalInstances } from '../../workspaceSwitch/browser/paradisTerminalEditorPark.js';

/** Only recent creations/disposals within this window count towards the rate. */
const RECENT_WINDOW_MS = 5 * 60 * 1000;
/** Creations (or disposals) within {@link RECENT_WINDOW_MS} needed to trigger a report. */
const RATE_THRESHOLD = 15;
/** Minimum gap between reports, so one burst does not send dozens of near-identical events. */
const REPORT_COOLDOWN_MS = 60 * 1000;

/**
 * Diagnoses a user report (2026-08) of empty terminal tabs silently piling up in the panel/editor
 * area over time. `ptyhost.log` shows the live terminal count climbing into the hundreds over
 * hours and then dropping sharply — a pattern no existing instrumentation surfaces, since none of
 * it tracks terminal creation/disposal *rate* over time. This watches
 * {@link ITerminalService.onDidCreateInstance}/`onDidDisposeInstance` and reports once the rate
 * crosses a threshold, so the next occurrence carries an actual Sentry event instead of only a
 * local log line.
 */
export class ParadisTerminalCountDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalCountDiagnostics';

	private readonly _createdAt: number[] = [];
	private readonly _createdEditorAt: number[] = [];
	private readonly _disposedAt: number[] = [];
	private readonly _reattachedAt: number[] = [];
	private _lastReportedAt = 0;
	/** Per-instance disposal listeners, keyed by instance id (see the constructor for why not the service event). */
	private readonly _disposalListeners = this._register(new DisposableMap<number>());

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@ITerminalGroupService private readonly _terminalGroupService: ITerminalGroupService,
	) {
		super();
		// Disposals are counted from each instance's own `onDisposed`, not from
		// `ITerminalService.onDidDisposeInstance`: closing a terminal editor tab removes the instance from
		// the editor service (and drops its forwarding listener) before the instance is disposed, so the
		// service event never fires for editor terminals. Counting from the service made 15 editor
		// terminals opened and closed in a few minutes look like 15 created and 0 disposed.
		for (const instance of this._terminalService.instances) {
			this._watchDisposal(instance);
		}
		this._register(this._terminalService.onDidCreateInstance(instance => this._onCreate(instance)));
	}

	private _onCreate(instance: ITerminalInstance): void {
		this._watchDisposal(instance);
		// A terminal that reattaches a pty which is already running (the startup revive of other spaces'
		// terminals, which parks them right away, or the reconnect after a reload) is not a new terminal.
		// Counting it made ~15-33 revived terminals look like a burst 10 s after every start.
		if (instance.shellLaunchConfig.attachPersistentProcess) {
			this._reattachedAt.push(Date.now());
			return;
		}
		if (instance.target === TerminalLocation.Editor) {
			this._createdEditorAt.push(Date.now());
		}
		this._onEvent('rapid-growth');
	}

	private _watchDisposal(instance: ITerminalInstance): void {
		if (this._disposalListeners.has(instance.instanceId)) {
			return;
		}
		this._disposalListeners.set(instance.instanceId, Event.once(instance.onDisposed)(() => {
			this._disposalListeners.deleteAndDispose(instance.instanceId);
			// Closing or reloading the window disposes every terminal at once; that is not the
			// disposal burst this diagnoses.
			if (!this._lifecycleService.willShutdown) {
				this._onEvent('rapid-shrink');
			}
		}));
	}

	private _onEvent(operation: 'rapid-growth' | 'rapid-shrink'): void {
		const now = Date.now();
		(operation === 'rapid-growth' ? this._createdAt : this._disposedAt).push(now);
		this._prune(this._createdAt, now);
		this._prune(this._createdEditorAt, now);
		this._prune(this._disposedAt, now);
		this._prune(this._reattachedAt, now);

		// Both are the net change: terminals opened and closed again within the window (an agent
		// launcher, a task run) are neither piling up nor dropping.
		const count = operation === 'rapid-growth' ? this._createdAt.length - this._disposedAt.length : this._disposedAt.length - this._createdAt.length;
		if (count < RATE_THRESHOLD || now - this._lastReportedAt < REPORT_COOLDOWN_MS) {
			return;
		}
		this._lastReportedAt = now;
		reportParadisDiagnosticError('owned', 'terminal-count', operation,
			new Error(`Terminal ${operation === 'rapid-growth' ? 'creation' : 'disposal'} rate exceeded threshold`), {
			safe_total_instances: this._terminalService.instances.length,
			// Parked terminals (other spaces) are alive but not in `instances`.
			safe_total_with_parked: paradisCollectAllTerminalInstances(this._terminalService, this._terminalGroupService).length,
			safe_recent_created_5min: this._createdAt.length,
			safe_recent_created_editor_5min: this._createdEditorAt.length,
			safe_recent_disposed_5min: this._disposedAt.length,
			safe_recent_reattached_5min: this._reattachedAt.length,
		});
	}

	private _prune(bucket: number[], now: number): void {
		const cutoff = now - RECENT_WINDOW_MS;
		while (bucket.length > 0 && bucket[0] < cutoff) {
			bucket.shift();
		}
	}
}

registerWorkbenchContribution2(ParadisTerminalCountDiagnosticsContribution.ID, ParadisTerminalCountDiagnosticsContribution, WorkbenchPhase.AfterRestored);
