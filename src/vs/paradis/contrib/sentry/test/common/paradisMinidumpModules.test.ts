/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisMinidumpExecutablePath, paradisReadMinidumpExecutablePath } from '../../common/paradisMinidumpModules.js';
import { createParadisTestMinidump } from './paradisMinidumpFixture.js';

suite('ParadisMinidumpModules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the crashed executable (the first module) and tolerates malformed dumps', () => {
		const dump = createParadisTestMinidump(['/opt/homebrew/bin/node', '/usr/lib/libc++.1.dylib']);
		const truncated = dump.slice(0, 70);
		const wrongSignature = dump.slice();
		wrongSignature[0] = 0;

		assert.deepStrictEqual({
			executable: paradisReadMinidumpExecutablePath(dump),
			truncated: paradisReadMinidumpExecutablePath(truncated),
			wrongSignature: paradisReadMinidumpExecutablePath(wrongSignature),
			empty: paradisReadMinidumpExecutablePath(new Uint8Array()),
			noModules: paradisReadMinidumpExecutablePath(createParadisTestMinidump([])),
			fromHint: paradisMinidumpExecutablePath([{ attachmentType: 'event.attachment', data: dump }, { attachmentType: 'event.minidump', data: dump }]),
			nonBinaryAttachment: paradisMinidumpExecutablePath([{ attachmentType: 'event.minidump', data: 'not bytes' }]),
		}, {
			executable: '/opt/homebrew/bin/node',
			truncated: undefined,
			wrongSignature: undefined,
			empty: undefined,
			noModules: undefined,
			fromHint: '/opt/homebrew/bin/node',
			nonBinaryAttachment: undefined,
		});
	});
});
