/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisQuarantineHost, paradisEnsureDownloadQuarantine } from '../../electron-main/paradisDownloadQuarantine.js';

function host(platform: NodeJS.Platform, options: { readonly hasMark: boolean }) {
	const commands: string[][] = [];
	const written: [string, string][] = [];
	const value: IParadisQuarantineHost = {
		platform,
		run: async (file, args) => {
			commands.push([file, ...args]);
			// `xattr -p` succeeds only when the attribute is already there; `-w` always succeeds here.
			return args[0] === '-p' ? options.hasMark : true;
		},
		exists: path => options.hasMark && path.endsWith(':Zone.Identifier'),
		writeFile: (path, content) => written.push([path, content]),
		now: () => 0x5f000000 * 1000,
	};
	return { value, commands, written };
}

suite('ParadisDownloadQuarantine', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the macOS quarantine attribute only when it is missing', async () => {
		const missing = host('darwin', { hasMark: false });
		const present = host('darwin', { hasMark: true });
		const results = [
			await paradisEnsureDownloadQuarantine('/dl/a.pdf', 'https://example.com/a.pdf', missing.value),
			await paradisEnsureDownloadQuarantine('/dl/a.pdf', 'https://example.com/a.pdf', present.value),
		];
		assert.deepStrictEqual(results, [true, false]);
		assert.deepStrictEqual(present.commands, [['/usr/bin/xattr', '-p', 'com.apple.quarantine', '/dl/a.pdf']]);
		const write = missing.commands[1];
		assert.deepStrictEqual(write.slice(0, 3), ['/usr/bin/xattr', '-w', 'com.apple.quarantine']);
		assert.match(write[3], /^0081;5f000000;Para Code;[0-9A-F-]{36}$/);
	});

	test('writes a Mark-of-the-Web stream on Windows without credentials, and does nothing on Linux', async () => {
		const windows = host('win32', { hasMark: false });
		const linux = host('linux', { hasMark: false });
		assert.deepStrictEqual([
			await paradisEnsureDownloadQuarantine('C:\\dl\\a.pdf', 'https://user:secret@example.com/a.pdf', windows.value),
			await paradisEnsureDownloadQuarantine('/dl/a.pdf', 'https://example.com/a.pdf', linux.value),
		], [true, false]);
		assert.deepStrictEqual(windows.written, [['C:\\dl\\a.pdf:Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://example.com/a.pdf\r\n']]);
		assert.deepStrictEqual([linux.commands, linux.written], [[], []]);
	});
});
