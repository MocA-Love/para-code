/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual, rejects } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PtyService } from '../../../../../platform/terminal/node/ptyService.js';
import { paradisResetReadopt, paradisTakeHandoverReport } from '../../node/paradisPtyReadopt.js';
import { paradisUsePtyDaemon } from '../../node/paradisTerminalProcessFactory.js';
import { paradisRelayDiagnosticsFromThisProcess, paradisTakeRelayedFailures } from '../../../sentry/common/paradisRelayedDiagnostics.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';

/**
 * The pty host has no Sentry SDK, so the failures the window cannot otherwise see (a pty id the host
 * does not have, a reconnect that failed) are counted and handed over with the handover report.
 * This covers the two counting points patched into `PtyService` and that a pty host without a
 * daemon still hands the counts over.
 */
suite('PtyService relayed failures', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	setup(() => {
		paradisUsePtyDaemon(undefined);
		// Other suites leave the startup adoption target behind; start from a pty host with neither a daemon nor a target.
		paradisResetReadopt();
		paradisTakeRelayedFailures();
		paradisRelayDiagnosticsFromThisProcess();
	});

	teardown(() => {
		configureParadisDiagnosticReporter(() => { });
		paradisTakeRelayedFailures();
	});

	function emptyService(): PtyService {
		const service = Object.create(PtyService.prototype) as PtyService;
		// `traceRpcArgs` is a getter over these two.
		Object.assign(service, { _ptys: new Map(), _logService: new NullLogService(), _simulatedLatency: 0 });
		return service;
	}

	test('a reconnect to an id the host does not have counts no-pty and reconnect-failed once each, and is handed over without a daemon', async () => {
		// Nothing counted, no daemon and no adoption target: the report stays undefined.
		const before = paradisTakeHandoverReport();

		await rejects(emptyService().attachToProcess(12));
		const report = paradisTakeHandoverReport();

		deepStrictEqual({ before, daemon: report?.daemon, failures: report?.failures }, {
			before: undefined,
			daemon: false,
			failures: [
				{ feature: 'pty-host', operation: 'no-pty', errorName: 'Error', severity: 'warning', count: 1 },
				{ feature: 'pty-host', operation: 'reconnect-failed', errorName: 'CodeExpectedError', severity: 'warning', count: 1 },
			],
		});
	});
});
