/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { transformErrorFromSerialization } from '../../../../../base/common/errors.js';
import { ListenerLeakError, ListenerRefusalError } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSafeErrorExtra } from '../../common/paradisSentryDiagnostics.js';
import { paradisUnhandledErrorSafeExtra } from '../../common/paradisUnhandledErrorExtra.js';

suite('paradisUnhandledErrorSafeExtra', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps the listener count, leak kind and emitter name of a listener leak, and nothing else', () => {
		assert.deepStrictEqual([
			paradisUnhandledErrorSafeExtra(new ListenerLeakError('dominated', 'details at /Users/example', 'stack', 175, 'contextKeyService')),
			paradisUnhandledErrorSafeExtra(new ListenerRefusalError('popular', 'details', 'stack', 1500)),
			paradisUnhandledErrorSafeExtra(Object.assign(new Error('plain'), { code: 'ERR_MODULE_NOT_FOUND' })),
			paradisUnhandledErrorSafeExtra('text'),
		], [
			{ safe_listener_count: 175, safe_leak_kind: 'dominated', safe_emitter_name: 'contextKeyService' },
			{ safe_listener_count: 1500, safe_leak_kind: 'popular' },
			undefined,
			undefined,
		]);
	});

	test('an extension host error keeps its Node code through serialization, so every report gets safe_errno', () => {
		const fromExtensionHost = transformErrorFromSerialization({ $isError: true, name: 'Error', message: 'Cannot find module /Users/example/x.js', stack: '', noTelemetry: false, code: 'ERR_MODULE_NOT_FOUND' });
		assert.deepStrictEqual(paradisSafeErrorExtra(fromExtensionHost), { safe_errno: 'ERR_MODULE_NOT_FOUND' });
	});
});
