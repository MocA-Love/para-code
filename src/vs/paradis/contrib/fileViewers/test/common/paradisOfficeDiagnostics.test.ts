/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { ParadisOfficeFailureLatch, resetParadisOfficeDiagnosticCounters } from '../../common/paradisOfficeDiagnostics.js';

suite('ParadisOfficeDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => {
		configureParadisDiagnosticReporter(() => { });
		resetParadisOfficeDiagnosticCounters();
	});

	test('reports the observed error itself, so its frames reach Sentry, and a placeholder only when there is none', () => {
		const reported: unknown[] = [];
		configureParadisDiagnosticReporter((_scope, _feature, _operation, error) => { reported.push(error); });
		const parserError = new TypeError('Cannot read properties of undefined');

		const withError = new ParadisOfficeFailureLatch('excel-view');
		withError.note({ cause: 'source', stage: 'source', error: parserError });
		withError.report('v1', 2 * 1024 * 1024);
		const withoutError = new ParadisOfficeFailureLatch('excel-view');
		withoutError.note({ cause: 'blank', stage: 'render' });
		withoutError.report('v1', 1024);

		assert.deepStrictEqual({
			first: reported[0] === parserError,
			second: reported[1] instanceof Error ? reported[1].message : reported[1],
		}, {
			first: true,
			second: 'Office excel-view failed to display (blank)',
		});
	});
});
