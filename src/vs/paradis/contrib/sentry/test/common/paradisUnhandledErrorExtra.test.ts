/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { transformErrorFromSerialization } from '../../../../../base/common/errors.js';
import { ListenerLeakError, ListenerRefusalError } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisUnhandledErrorSafeExtra } from '../../common/paradisUnhandledErrorExtra.js';

suite('paradisUnhandledErrorSafeExtra', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the listener count, leak kind, emitter name and error code, and nothing else', () => {
		const fromExtensionHost = transformErrorFromSerialization({ $isError: true, name: 'Error', message: 'Cannot find module /Users/example/x.js', stack: '', noTelemetry: false, code: 'ERR_MODULE_NOT_FOUND' });
		const withPathCode = Object.assign(new Error('x'), { code: '/Users/example/secret' });
		const throwing = { get code(): string { throw new Error('boom'); } };
		assert.deepStrictEqual([
			paradisUnhandledErrorSafeExtra(new ListenerLeakError('dominated', 'details at /Users/example', 'stack', 175, 'contextKeyService')),
			paradisUnhandledErrorSafeExtra(new ListenerRefusalError('popular', 'details', 'stack', 1500)),
			paradisUnhandledErrorSafeExtra(fromExtensionHost),
			paradisUnhandledErrorSafeExtra(withPathCode),
			paradisUnhandledErrorSafeExtra(new Error('plain')),
			paradisUnhandledErrorSafeExtra(throwing),
			paradisUnhandledErrorSafeExtra('text'),
		], [
			{ safe_listener_count: 175, safe_leak_kind: 'dominated', safe_emitter_name: 'contextKeyService' },
			{ safe_listener_count: 1500, safe_leak_kind: 'popular' },
			{ safe_error_code: 'ERR_MODULE_NOT_FOUND' },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});
});
