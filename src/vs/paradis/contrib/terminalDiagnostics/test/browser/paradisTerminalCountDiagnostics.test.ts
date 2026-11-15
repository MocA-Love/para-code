/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import type { ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisTerminalCountDiagnosticsContribution } from '../../browser/paradisTerminalCountDiagnostics.contribution.js';

suite('ParadisTerminalCountDiagnostics', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// エディタの端末のタブを閉じると、端末のサービスから外された後に破棄されるので、サービスの破棄の知らせは来ない。
	// 端末自身の破棄の知らせで数え、開いてすぐ閉じたものは増えたと数えない
	test('counts editor terminals closed without the service event, and does not report terminals opened and closed again', () => {
		const disposables = store.add(new DisposableStore());
		const onDidCreateInstance = disposables.add(new Emitter<ITerminalInstance>());
		const instances: ITerminalInstance[] = [];
		const terminalService = { instances, onDidCreateInstance: onDidCreateInstance.event } as unknown as ITerminalService;
		const reports: { readonly operation: string; readonly safeExtra: unknown }[] = [];
		configureParadisDiagnosticReporter((_scope, _feature, operation, _error, safeExtra) => reports.push({ operation, safeExtra }));
		try {
			disposables.add(new ParadisTerminalCountDiagnosticsContribution(terminalService, { willShutdown: false } as ILifecycleService));
			const create = (id: number) => {
				const onDisposed = disposables.add(new Emitter<ITerminalInstance>());
				const instance = { instanceId: id, target: TerminalLocation.Editor, onDisposed: onDisposed.event } as unknown as ITerminalInstance;
				onDidCreateInstance.fire(instance);
				return () => onDisposed.fire(instance);
			};
			for (let id = 1; id <= 20; id++) {
				create(id)();
			}
			const afterChurn = reports.length;
			for (let id = 21; id <= 55; id++) {
				create(id);
			}
			assert.deepStrictEqual({ afterChurn, reports: reports.map(report => ({ operation: report.operation, safeExtra: report.safeExtra })) }, {
				afterChurn: 0,
				reports: [{ operation: 'rapid-growth', safeExtra: { safe_total_instances: 0, safe_recent_created_5min: 35, safe_recent_created_editor_5min: 35, safe_recent_disposed_5min: 20 } }],
			});
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
