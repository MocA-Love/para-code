/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IUtilitySentryChildResult } from './paradisSentryUtility.child.js';

suite('ParadisSentryUtility', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let result: IUtilitySentryChildResult;

	suiteSetup(async () => {
		result = await runIsolatedUtilityScenario();
	});

	test('initializes the utility SDK with privacy defaults and Para-only tracing', () => {
		assert.deepStrictEqual(result.initialization, {
			sendDefaultPii: false,
			includeLocalVariables: false,
			enableLogs: false,
			paraTraceRate: 1,
			upstreamTraceRate: 0,
		});
		assert.deepStrictEqual(result.tags, {
			'para.scope': 'unknown',
			'process.type': 'utility',
			'device.arch': process.arch,
			'os.name': process.platform,
			'para.pairing': 'pairing-hash-fragment',
		});
	});

	test('re-sanitizes forwarded events without replacing their originating process', () => {
		assert.deepStrictEqual(result.forwardedEvent, {
			message: 'failed for ~/private.ts while requesting https://example.test/private',
			user: null,
			request: null,
			serverName: null,
			processType: 'renderer',
			contexts: {
				runtime: { name: 'node', version: '24' },
			},
		});
	});

	test('forwards explicit captures through an isolated scope', () => {
		assert.strictEqual(result.directCaptureId, 'fake-sentry-event-id');
	});

	test('connects the diagnostic reporter and correlation tag APIs to the utility SDK', () => {
		assert.deepStrictEqual(result.captures, [{
			errorMessage: 'Para Code diagnostic: mobile-relay.reconnect',
			scope: {
				tags: {
					'para.scope': 'patched',
					'para.feature': 'mobile-relay',
					'para.operation': 'reconnect',
				},
				extras: { attempt: 2 },
			},
		}, {
			errorMessage: 'Para Code diagnostic: terminal-environment.resolve',
			scope: {
				tags: {
					'para.scope': 'owned',
					'para.feature': 'terminal-environment',
					'para.operation': 'resolve',
				},
				extras: { duration_ms: 321, phase: 'resolve' },
			},
		}]);
		assert.deepStrictEqual(result.breadcrumbs, [{
			category: 'para.mobile-relay',
			message: 'reconnect',
			data: { attempt: 2 },
		}, {
			category: 'para.terminal-environment',
			message: 'resolve',
			data: { duration_ms: 321, phase: 'resolve' },
		}]);
		assert.strictEqual(result.tags['para.pairing'], 'pairing-hash-fragment');
	});

	test('runs utility spans with the public Para correlation attributes', () => {
		assert.strictEqual(result.spanResult, 42);
		assert.deepStrictEqual(result.spans, [{
			name: 'para.terminal.resolve-shell',
			op: 'para.terminal',
			attributes: {
				'para.scope': 'owned',
				'para.feature': 'terminal',
				'para.operation': 'resolve-shell',
			},
		}]);
	});

	function runIsolatedUtilityScenario(): Promise<IUtilitySentryChildResult> {
		const childPath = fileURLToPath(new URL('./paradisSentryUtility.child.js', import.meta.url));
		return new Promise((resolve, reject) => {
			execFile(process.execPath, [childPath], {
				env: createChildEnvironment(),
				timeout: 15_000,
			}, (error, stdout, stderr) => {
				if (error) {
					reject(new Error(`Utility Sentry child failed: ${stderr || error.message}`));
					return;
				}
				try {
					resolve(JSON.parse(stdout) as IUtilitySentryChildResult);
				} catch (parseError) {
					reject(new Error(`Utility Sentry child returned invalid JSON: ${stdout}; stderr: ${stderr || '<empty>'}`, { cause: parseError }));
				}
			});
		});
	}

	function createChildEnvironment(): NodeJS.ProcessEnv {
		const childEnvironment: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
		for (const key of [
			'PATH',
			'HOME',
			'TMPDIR',
			'TEMP',
			'TMP',
			'USERPROFILE',
			'LOCALAPPDATA',
			'APPDATA',
			'SystemRoot',
			'WINDIR',
			'ComSpec',
			'PATHEXT',
			'LANG',
			'LC_ALL',
		]) {
			const value = process.env[key];
			if (value !== undefined) {
				childEnvironment[key] = value;
			}
		}
		return childEnvironment;
	}
});
