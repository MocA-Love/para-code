/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	configureParadisDiagnosticReporter,
	reportParadisDiagnosticError,
	paradisSafeErrorName,
	toParadisSentrySafeError,
} from '../../common/paradisSentryDiagnostics.js';

suite('ParadisSentryDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces the message and keeps only sanitized frames from our own sources', () => {
		const source = new Error('private response body at file:///Users/alice/private.ts', {
			cause: new Error('private cause'),
		});
		source.stack = [
			'Error: private response body at file:///Users/alice/private.ts',
			'    at parse (/Users/alice/private.ts:1:2)',
			'private multiline continuation',
			'    at request (app:///out/request.js:2:3)',
			'    at fetchStatus (/Users/alice/Applications/Para Code.app/Contents/Resources/app/out/vs/paradis/contrib/serviceStatus/electron-browser/x.js:10:5)',
			'    at handler (C:\\Users\\alice\\AppData\\Local\\Programs\\Para Code\\resources\\app\\out\\vs\\workbench\\y.js:3:4)',
			'    at ext (~/.para-code/extensions/some.ext-1.0.0/out/z.js:7:8)',
			'    at vendored (/Users/alice/app/node_modules/lib/index.js:1:1)',
		].join('\n');

		const safe = toParadisSentrySafeError('service-status', 'fetch-failed', source);

		assert.notStrictEqual(safe, source);
		assert.deepStrictEqual({
			name: safe.name,
			message: safe.message,
			hasCause: Object.hasOwn(safe, 'cause'),
			stack: safe.stack,
		}, {
			name: 'Error',
			message: 'Para Code diagnostic: service-status.fetch-failed',
			hasCause: false,
			stack: [
				'Error: Para Code diagnostic: service-status.fetch-failed',
				'    at fetchStatus (~/Applications/Para Code.app/Contents/Resources/app/out/vs/paradis/contrib/serviceStatus/electron-browser/x.js:10:5)',
				'    at handler (~\\AppData\\Local\\Programs\\Para Code\\resources\\app\\out\\vs\\workbench\\y.js:3:4)',
			].join('\n'),
		});
	});

	test('falls back to a frame-free stack when no frame is ours', () => {
		const source = new Error('private');
		source.stack = 'Error: private\n    at parse (/Users/alice/private.ts:1:2)';
		assert.strictEqual(toParadisSentrySafeError('terminal', 'spawn', source).stack, 'Error: Para Code diagnostic: terminal.spawn');
	});

	test('derives a content-free error name for grouping', () => {
		class ParadisTimeoutError extends Error { override name = 'ParadisTimeoutError'; }
		const throwingName = { get name(): string { throw new Error('private'); } };
		const cases: Array<[unknown, string]> = [
			[new TypeError('x'), 'TypeError'],
			[new ParadisTimeoutError('x'), 'ParadisTimeoutError'],
			[Object.assign(new Error('x'), { name: 'has spaces and /Users/alice' }), 'Error'],
			[{ message: 'private', name: 'RangeError' }, 'RangeError'],
			[{ code: 'ENOENT', errno: -2, syscall: 'open', path: '/Users/alice/secret' }, 'ENOENT'],
			[{ message: 'private', name: 'not an identifier: /Users/alice' }, 'object'],
			[{ vslsStack: [] }, 'object'],
			['private-string-value', 'string'],
			[undefined, 'undefined'],
			[null, 'object'],
			[throwingName, 'unknown'],
			[Object.defineProperty(new Error('x'), 'name', { get: () => undefined }), 'Error'],
			[{ code: 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND' }, 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND'],
			[{ code: 'deadbeef'.repeat(8) }, 'object'],
		];
		assert.deepStrictEqual(cases.map(([error]) => paradisSafeErrorName(error)), cases.map(([, name]) => name));
	});

	test('does not stringify thrown values or read a throwing stack getter', () => {
		let stackReads = 0;
		const thrownObject = {
			secret: 'private-object-value',
			get stack(): string {
				stackReads++;
				throw new Error('private getter value');
			},
		};

		const fromString = toParadisSentrySafeError('terminal', 'spawn', 'private-string-value');
		const fromObject = toParadisSentrySafeError('terminal', 'spawn', thrownObject);

		assert.strictEqual(fromString.message, 'Para Code diagnostic: terminal.spawn');
		assert.strictEqual(fromObject.message, 'Para Code diagnostic: terminal.spawn');
		assert.ok(!fromString.stack?.includes('private-string-value'));
		assert.ok(!fromObject.stack?.includes('private-object-value'));
		assert.ok(!fromObject.stack?.includes('private getter value'));
		assert.strictEqual(stackReads, 0);
	});

	test('keeps the original error identity until the process adapter boundary', () => {
		const original = new Error('domain-visible-error');
		let received: unknown;
		configureParadisDiagnosticReporter((_scope, _feature, _operation, error) => {
			received = error;
		});

		try {
			reportParadisDiagnosticError('owned', 'mobile-relay', 'backend-acquire', original);
			assert.strictEqual(received, original);
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
