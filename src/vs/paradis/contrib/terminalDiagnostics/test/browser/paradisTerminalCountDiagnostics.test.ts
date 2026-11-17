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
import type { ITerminalGroupService, ITerminalInstance, ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import type { ILifecycleService } from '../../../../../workbench/services/lifecycle/common/lifecycle.js';
import { configureParadisDiagnosticReporter, isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
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
			disposables.add(new ParadisTerminalCountDiagnosticsContribution(terminalService, { willShutdown: false } as ILifecycleService, { paradisParkedGroups: [] } as unknown as ITerminalGroupService));
			const create = (id: number) => {
				const onDisposed = disposables.add(new Emitter<ITerminalInstance>());
				const instance = { instanceId: id, target: TerminalLocation.Editor, shellLaunchConfig: {}, onDisposed: onDisposed.event } as unknown as ITerminalInstance;
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
				reports: [{ operation: 'rapid-growth', safeExtra: { safe_total_instances: 0, safe_total_with_parked: 0, safe_recent_created_5min: 35, safe_recent_created_editor_5min: 35, safe_recent_disposed_5min: 20, safe_recent_reattached_5min: 0 } }],
			});
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});

	// 起動時の復元は、ほかのスペースの端末を動いている pty へ繋ぎ直してすぐ預ける。新しい端末ではないので増えたと数えず、
	// 預けたものは生きている数に入れる。その後に新しく 15 本増えたときだけ知らせる
	test('does not count terminals that reattach a running pty, and counts parked terminals as alive', () => {
		const disposables = store.add(new DisposableStore());
		const onDidCreateInstance = disposables.add(new Emitter<ITerminalInstance>());
		const instances: ITerminalInstance[] = [];
		const parkedGroup = { terminalInstances: [] as ITerminalInstance[] };
		const terminalService = { instances, onDidCreateInstance: onDidCreateInstance.event } as unknown as ITerminalService;
		const terminalGroupService = { paradisParkedGroups: [parkedGroup] } as unknown as ITerminalGroupService;
		const reports: { readonly operation: string; readonly safeExtra: unknown }[] = [];
		configureParadisDiagnosticReporter((_scope, _feature, operation, _error, safeExtra) => reports.push({ operation, safeExtra }));
		try {
			disposables.add(new ParadisTerminalCountDiagnosticsContribution(terminalService, { willShutdown: false } as ILifecycleService, terminalGroupService));
			// The service lists a terminal before it announces it, so the list is filled before firing.
			const create = (id: number, reattach: boolean, list: ITerminalInstance[]) => {
				const onDisposed = disposables.add(new Emitter<ITerminalInstance>());
				const instance = {
					instanceId: id,
					isDisposed: false,
					target: TerminalLocation.Panel,
					shellLaunchConfig: reattach ? { attachPersistentProcess: { id } } : {},
					onDisposed: onDisposed.event,
				} as unknown as ITerminalInstance;
				list.push(instance);
				onDidCreateInstance.fire(instance);
			};
			for (let id = 1; id <= 33; id++) {
				create(id, true, parkedGroup.terminalInstances);
			}
			const afterRevive = reports.length;
			for (let id = 34; id <= 48; id++) {
				create(id, false, instances);
			}
			assert.deepStrictEqual({ afterRevive, reports }, {
				afterRevive: 0,
				reports: [{ operation: 'rapid-growth', safeExtra: { safe_total_instances: 15, safe_total_with_parked: 48, safe_recent_created_5min: 15, safe_recent_created_editor_5min: 0, safe_recent_disposed_5min: 0, safe_recent_reattached_5min: 33 } }],
			});
			assert.deepStrictEqual(Object.keys(reports[0].safeExtra as object).filter(isParadisSentryScrubbedWord), []);
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
