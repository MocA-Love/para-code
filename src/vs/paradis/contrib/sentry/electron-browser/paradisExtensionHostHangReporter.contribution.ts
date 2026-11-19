/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ExtensionHostKind } from '../../../../workbench/services/extensions/common/extensionHostKind.js';
import { IExtensionService } from '../../../../workbench/services/extensions/common/extensions.js';
import { IParadisHangEpisode, ParadisHangEpisodeTracker, ParadisHangReportBudget } from '../common/paradisHangTelemetry.js';
import { reportParadisDiagnosticError } from '../common/paradisSentryDiagnostics.js';

/**
 * 手元の拡張ホストが応答しなくなったことを、1 回につき 1 件 Sentry へ送る。upstream は
 * `abstractExtensionService.ts` で info のログに書くだけで、Sentry には届いていなかった。
 * 送るのは固まっていた時間と戻ったかだけ（どの拡張かは送らない）。
 */
export class ParadisExtensionHostHangReporter extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.paradisExtensionHostHangReporter';

	constructor(@IExtensionService extensionService: IExtensionService) {
		super();
		const budget = new ParadisHangReportBudget();
		const tracker = this._register(new ParadisHangEpisodeTracker(episode => this.report(budget, episode)));
		this._register(extensionService.onDidChangeResponsiveChange(event => {
			if (event.extensionHostKind === ExtensionHostKind.LocalProcess) {
				tracker.setResponsive(event.isResponsive);
			}
		}));
	}

	private report(budget: ParadisHangReportBudget, episode: IParadisHangEpisode): void {
		try {
			const decision = budget.take();
			if (!decision.allowed) {
				return;
			}
			reportParadisDiagnosticError('owned', 'extension-host-hang', 'unresponsive', new Error('extension host unresponsive'), {
				...episode,
				...(decision.skipped > 0 ? { safe_hang_reports_skipped: decision.skipped } : {}),
			}, 'warning');
		} catch {
			// Diagnostics must never change the behavior they observe.
		}
	}
}

registerWorkbenchContribution2(ParadisExtensionHostHangReporter.ID, ParadisExtensionHostHangReporter, WorkbenchPhase.AfterRestored);
