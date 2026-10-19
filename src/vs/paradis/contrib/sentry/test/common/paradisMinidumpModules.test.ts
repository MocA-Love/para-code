/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisMinidumpAnnotation, paradisMinidumpExecutablePath, paradisReadMinidumpAnnotation, paradisReadMinidumpExecutablePath } from '../../common/paradisMinidumpModules.js';
import { createParadisTestCrashpadMinidump, createParadisTestMinidump } from './paradisMinidumpFixture.js';

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

	test('reads a crashpad annotation from the module annotations Electron writes, and tolerates malformed dumps', () => {
		// Electron's crash keys (`ptype`, `pid`, and what `addExtraParameter` adds) are annotation
		// objects of the Electron framework module; the dump-wide simple dictionary holds product keys.
		const dump = createParadisTestCrashpadMinidump({
			simple: { prod: 'Electron', ver: '43.7.7' },
			objects: { ptype: 'node', pid: '19709', para_role: 'pty-host-daemon', binary: 'x' },
			types: { binary: 2 },
		});
		const moduleSimple = createParadisTestCrashpadMinidump({ moduleSimple: { para_role: 'devtools-mcp' } });
		const roleOnly = createParadisTestCrashpadMinidump({ objects: { para_role: 'pty-daemon' } });
		const truncated = roleOnly.slice(0, roleOnly.byteLength - 2);

		assert.deepStrictEqual({
			role: paradisReadMinidumpAnnotation(dump, 'para_role'),
			ptype: paradisReadMinidumpAnnotation(dump, 'ptype'),
			dumpWide: paradisReadMinidumpAnnotation(dump, 'ver'),
			nonString: paradisReadMinidumpAnnotation(dump, 'binary'),
			missing: paradisReadMinidumpAnnotation(dump, 'processType'),
			moduleSimple: paradisReadMinidumpAnnotation(moduleSimple, 'para_role'),
			noCrashpadStream: paradisReadMinidumpAnnotation(createParadisTestMinidump(['/opt/homebrew/bin/node']), 'para_role'),
			roleOnly: paradisReadMinidumpAnnotation(roleOnly, 'para_role'),
			truncated: paradisReadMinidumpAnnotation(truncated, 'para_role'),
			garbage: paradisReadMinidumpAnnotation(new Uint8Array([0x4d, 0x44, 0x4d, 0x50, 1, 2, 3]), 'para_role'),
			executableStillRead: paradisReadMinidumpExecutablePath(dump),
			fromHint: paradisMinidumpAnnotation([{ attachmentType: 'event.minidump', data: dump }], 'para_role'),
		}, {
			role: 'pty-host-daemon',
			ptype: 'node',
			dumpWide: '43.7.7',
			nonString: undefined,
			missing: undefined,
			moduleSimple: 'devtools-mcp',
			noCrashpadStream: undefined,
			roleOnly: 'pty-daemon',
			truncated: undefined,
			garbage: undefined,
			executableStillRead: '/Applications/Para Code.app/Contents/MacOS/Para Code',
			fromHint: 'pty-host-daemon',
		});
	});
});
