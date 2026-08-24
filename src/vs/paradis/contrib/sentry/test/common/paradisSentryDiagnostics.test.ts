/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	configureParadisDiagnosticReporter,
	reportParadisDiagnosticError,
	toParadisSentrySafeError,
} from '../../common/paradisSentryDiagnostics.js';

suite('ParadisSentryDiagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('replaces every source field with a fixed message and a frame-free stack', () => {
		const source = new Error('private response body at file:///Users/alice/private.ts', {
			cause: new Error('private cause'),
		});
		source.stack = [
			'Error: private response body at file:///Users/alice/private.ts',
			'    at parse (/Users/alice/private.ts:1:2)',
			'private multiline continuation',
			'    at request (app:///out/request.js:2:3)',
		].join('\n');

		const safe = toParadisSentrySafeError('service-status', 'fetch-failed', source);

		assert.notStrictEqual(safe, source);
		assert.strictEqual(safe.name, 'Error');
		assert.strictEqual(safe.message, 'Para Code diagnostic: service-status.fetch-failed');
		assert.strictEqual(safe.stack, 'Error: Para Code diagnostic: service-status.fetch-failed');
		assert.strictEqual(Object.hasOwn(safe, 'cause'), false);
		assert.ok(!safe.stack?.includes('private response body'));
		assert.ok(!safe.stack?.includes('/Users/alice'));
		assert.ok(!safe.stack?.includes('private multiline continuation'));
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
