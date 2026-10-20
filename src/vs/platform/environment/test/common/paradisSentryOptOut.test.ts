/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IParadisCrashReportingInputs, isParadisSentryDisabledByEnv, isParadisSentryOptedOut, setParadisSentryDisabledEnv } from '../../common/paradisSentryOptOut.js';

suite('paradisSentryOptOut', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('opts out under any of the upstream crash reporter opt-outs, and not when argv.json has no value yet', () => {
		const cases: IParadisCrashReportingInputs[] = [
			{},
			{ enableCrashReporter: true },
			{ enableCrashReporter: false },
			{ enableCrashReporter: true, disableCrashReporter: true },
			{ disableCrashReporter: false },
			{ enableCrashReporter: true, crashReporterDirectory: '/crashes' },
			{ enableCrashReporter: true, crashReporterDirectory: '' },
		];
		assert.deepStrictEqual(cases.map(isParadisSentryOptedOut), [false, false, true, true, false, true, false]);
	});

	test('passes the decision through the environment and overwrites an inherited value', () => {
		const env: Record<string, string | undefined> = {};
		const seen: boolean[] = [isParadisSentryDisabledByEnv(env)];
		setParadisSentryDisabledEnv(env, true);
		seen.push(isParadisSentryDisabledByEnv(env));
		setParadisSentryDisabledEnv(env, false);
		seen.push(isParadisSentryDisabledByEnv(env), Object.keys(env).length === 0);
		assert.deepStrictEqual(seen, [false, true, false, true]);
	});
});
