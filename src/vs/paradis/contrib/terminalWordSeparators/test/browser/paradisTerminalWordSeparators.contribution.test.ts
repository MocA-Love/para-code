/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { configureParadisDiagnosticReporter, type ParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';

type ParadisTerminalWordSeparatorsModule = typeof import('../../browser/paradisTerminalWordSeparators.contribution.js');

suite('Paradis terminal word separator diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const registeredDefaultsBeforeImport = new Set(configurationRegistry.getRegisteredDefaultConfigurations());
	const importReports: Array<Parameters<ParadisDiagnosticReporter>> = [];
	let contributionModule: ParadisTerminalWordSeparatorsModule;

	suiteSetup(async () => {
		configureParadisDiagnosticReporter((...args) => importReports.push(args));

		try {
			contributionModule = await import('../../browser/paradisTerminalWordSeparators.contribution.js');
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});

	suiteTeardown(() => {
		const defaultsAddedByImport = configurationRegistry.getRegisteredDefaultConfigurations()
			.filter(defaultConfiguration => !registeredDefaultsBeforeImport.has(defaultConfiguration));
		configurationRegistry.deregisterDefaultConfigurations(defaultsAddedByImport);
	});

	test('defers a missing-default report until contribution construction', () => {
		assert.deepStrictEqual(importReports, []);
		const reports: Array<Parameters<ParadisDiagnosticReporter>> = [];
		configureParadisDiagnosticReporter((...args) => reports.push(args));

		try {
			new contributionModule.ParadisTerminalWordSeparatorsDiagnosticsContribution();
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}

		assert.strictEqual(reports.length, 1);
	});

	test('self-registers the diagnostic contribution exactly once during module initialization', () => {
		const registrations: Array<{
			readonly id: string;
			readonly ctor: typeof contributionModule.ParadisTerminalWordSeparatorsDiagnosticsContribution;
			readonly phase: WorkbenchPhase;
		}> = [];
		let initializationError: Error | undefined;

		try {
			contributionModule.initializeParadisTerminalWordSeparatorsDiagnosticsContribution(
				(id, ctor, phase) => registrations.push({ id, ctor, phase }),
			);
		} catch (error) {
			if (error instanceof Error) {
				initializationError = error;
			}
		}

		assert.deepStrictEqual({
			registrations,
			initializationErrorName: initializationError?.name,
		}, {
			registrations: [],
			initializationErrorName: 'Error',
		});
	});

	test('registers the diagnostic contribution after the workbench is restored', () => {
		const registrations: Array<{
			readonly id: string;
			readonly ctor: typeof contributionModule.ParadisTerminalWordSeparatorsDiagnosticsContribution;
			readonly phase: WorkbenchPhase;
		}> = [];

		contributionModule.registerParadisTerminalWordSeparatorsDiagnosticsContribution(
			(id, ctor, phase) => registrations.push({ id, ctor, phase }),
		);

		assert.deepStrictEqual(registrations, [{
			id: 'workbench.contrib.paradisTerminalWordSeparatorsDiagnostics',
			ctor: contributionModule.ParadisTerminalWordSeparatorsDiagnosticsContribution,
			phase: WorkbenchPhase.AfterRestored,
		}]);
	});

	test('reports a fixed error only when the captured upstream default is missing', () => {
		const reports: Array<Parameters<ParadisDiagnosticReporter>> = [];
		const reporter: ParadisDiagnosticReporter = (scope, feature, operation, error, safeExtra, severity) => {
			reports.push([scope, feature, operation, error, safeExtra, severity]);
		};

		contributionModule.reportParadisTerminalWordSeparatorsDefault(undefined, reporter);
		contributionModule.reportParadisTerminalWordSeparatorsDefault(' ()[]{}', reporter);

		assert.deepStrictEqual(reports.map(report => ({
			scope: report[0],
			feature: report[1],
			operation: report[2],
			message: report[3] instanceof Error ? report[3].message : undefined,
		})), [{
			scope: 'owned',
			feature: 'terminal-word-separators',
			operation: 'default-missing',
			message: 'terminal.integrated.wordSeparators default was not found in the configuration registry',
		}]);
	});
});
