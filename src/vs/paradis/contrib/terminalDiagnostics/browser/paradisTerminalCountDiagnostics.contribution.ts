/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { reportParadisDiagnosticError } from '../../sentry/common/paradisSentryDiagnostics.js';

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
class ParadisTerminalCountDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisTerminalCountDiagnostics';

	private readonly _createdAt: number[] = [];
	private readonly _createdEditorAt: number[] = [];
	private readonly _disposedAt: number[] = [];
	private _lastReportedAt = 0;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
		this._register(this._terminalService.onDidCreateInstance(instance => this._onCreate(instance)));
		this._register(this._terminalService.onDidDisposeInstance(() => this._onEvent('rapid-shrink')));
	}

	private _onCreate(instance: ITerminalInstance): void {
		if (instance.target === TerminalLocation.Editor) {
			this._createdEditorAt.push(Date.now());
		}
		this._onEvent('rapid-growth');
	}

	private _onEvent(operation: 'rapid-growth' | 'rapid-shrink'): void {
		const now = Date.now();
		(operation === 'rapid-growth' ? this._createdAt : this._disposedAt).push(now);
		this._prune(this._createdAt, now);
		this._prune(this._createdEditorAt, now);
		this._prune(this._disposedAt, now);

		const bucket = operation === 'rapid-growth' ? this._createdAt : this._disposedAt;
		if (bucket.length < RATE_THRESHOLD || now - this._lastReportedAt < REPORT_COOLDOWN_MS) {
			return;
		}
		this._lastReportedAt = now;
		reportParadisDiagnosticError('owned', 'terminal-count', operation,
			new Error(`Terminal ${operation === 'rapid-growth' ? 'creation' : 'disposal'} rate exceeded threshold`), {
			safe_total_instances: this._terminalService.instances.length,
			safe_recent_created_5min: this._createdAt.length,
			safe_recent_created_editor_5min: this._createdEditorAt.length,
			safe_recent_disposed_5min: this._disposedAt.length,
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
