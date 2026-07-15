/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisCaptureTerminalCreationScopeLease,
	paradisGetTerminalCreationScopeLease,
	paradisRegisterTerminalCreationScopeProvider,
	paradisSetTerminalCreationScopeLease,
	paradisTakeTerminalCreationScopeLease,
} from '../../browser/paradisTerminalCreationScope.js';

suite('Paradis terminal creation scope lease', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('captures the current provider and only the current registration can clear it', () => {
		const first = paradisRegisterTerminalCreationScopeProvider(() => 'scope:first');
		const replacement = paradisRegisterTerminalCreationScopeProvider(() => 'scope:replacement');
		try {
			assert.strictEqual(paradisCaptureTerminalCreationScopeLease(undefined), 'scope:replacement');
			first.dispose();
			assert.strictEqual(paradisCaptureTerminalCreationScopeLease(undefined), 'scope:replacement');
		} finally {
			first.dispose();
			replacement.dispose();
		}
		assert.strictEqual(paradisCaptureTerminalCreationScopeLease(undefined), undefined);
	});

	test('accepts only bounded control-free leases and associates them by config identity', () => {
		const registration = paradisRegisterTerminalCreationScopeProvider(() => 'scope:fallback');
		try {
			assert.strictEqual(paradisCaptureTerminalCreationScopeLease('scope:explicit'), 'scope:explicit');
			assert.strictEqual(paradisCaptureTerminalCreationScopeLease('scope:\ninvalid'), 'scope:fallback');
			assert.strictEqual(paradisCaptureTerminalCreationScopeLease('x'.repeat(4_097)), 'scope:fallback');

			const firstConfig = {};
			const secondConfig = {};
			paradisSetTerminalCreationScopeLease(firstConfig, 'scope:explicit');
			paradisSetTerminalCreationScopeLease(firstConfig, 'scope:next');
			assert.strictEqual(paradisGetTerminalCreationScopeLease(firstConfig), 'scope:next');
			assert.strictEqual(paradisTakeTerminalCreationScopeLease(firstConfig), 'scope:next');
			assert.strictEqual(paradisTakeTerminalCreationScopeLease(firstConfig), undefined);
			assert.strictEqual(paradisGetTerminalCreationScopeLease(secondConfig), undefined);
		} finally {
			registration.dispose();
		}
	});
});
