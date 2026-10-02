/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisFormatMode,
	paradisFormatOctalMode,
	paradisIsValidMode,
	paradisModeBit,
	paradisParseModeString,
	paradisParseOctalMode,
	paradisRecursiveModeFor,
} from '../../common/paradisFileTransfer.js';

suite('Paradis file transfer - permissions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats st_mode like ls -l, including setuid / setgid / sticky', () => {
		assert.deepStrictEqual([
			paradisFormatMode(0o755, 'd'),
			paradisFormatMode(0o644, '-'),
			paradisFormatMode(0o600, '-'),
			paradisFormatMode(0o777, 'l'),
			paradisFormatMode(0o4755, '-'),
			paradisFormatMode(0o4644, '-'),
			paradisFormatMode(0o2775, 'd'),
			paradisFormatMode(0o1777, 'd'),
			paradisFormatMode(0o1776, 'd'),
		], [
			'drwxr-xr-x',
			'-rw-r--r--',
			'-rw-------',
			'lrwxrwxrwx',
			'-rwsr-xr-x',
			'-rwSr--r--',
			'drwxrwsr-x',
			'drwxrwxrwt',
			'drwxrwxrwT',
		]);
	});

	test('parses what it formats, with or without the type character', () => {
		const modes = [0o755, 0o644, 0o600, 0o4755, 0o4644, 0o2775, 0o1777, 0o1776, 0o000, 0o7777];
		assert.deepStrictEqual(
			modes.map(mode => [paradisParseModeString(paradisFormatMode(mode, '-')), paradisParseModeString(paradisFormatMode(mode, 'd').slice(1))]),
			modes.map(mode => [mode, mode]),
		);
	});

	test('rejects strings that are not a permission string', () => {
		assert.deepStrictEqual(
			['', 'rwx', 'rwxr-xr-xx', 'rwxr-xr-q', 'xwxr-xr-x', 'zrwxr-xr-x', 'rw-r--r-s'].map(paradisParseModeString),
			[undefined, undefined, undefined, undefined, undefined, undefined, undefined],
		);
	});

	test('reads and writes the octal field', () => {
		assert.deepStrictEqual({
			parsed: ['755', '0755', '4755', ' 644 ', '75', '888', '17777', 'abc'].map(paradisParseOctalMode),
			formatted: [0o755, 0o644, 0o4755, 0o1777, 0o7].map(paradisFormatOctalMode),
		}, {
			parsed: [0o755, 0o755, 0o4755, 0o644, undefined, undefined, undefined, undefined],
			formatted: ['755', '644', '4755', '1777', '007'],
		});
	});

	test('maps the grid cells to bits', () => {
		assert.deepStrictEqual([
			paradisModeBit('owner', 'read'),
			paradisModeBit('owner', 'write'),
			paradisModeBit('owner', 'execute'),
			paradisModeBit('group', 'read'),
			paradisModeBit('other', 'execute'),
		], [0o400, 0o200, 0o100, 0o040, 0o001]);
	});

	test('recursive change keeps whether a file was executable', () => {
		assert.deepStrictEqual({
			directory: paradisRecursiveModeFor(0o755, true, 0o700),
			plainFile: paradisRecursiveModeFor(0o755, false, 0o644),
			executableFile: paradisRecursiveModeFor(0o755, false, 0o700),
			readOnly: paradisRecursiveModeFor(0o700, false, 0o664),
		}, {
			directory: 0o755,
			plainFile: 0o644,
			executableFile: 0o755,
			readOnly: 0o600,
		});
	});

	test('recursive change does not carry setuid / setgid / sticky into files', () => {
		assert.deepStrictEqual({
			setgidFolder: paradisRecursiveModeFor(0o2775, true, 0o755),
			executableFile: paradisRecursiveModeFor(0o2775, false, 0o755).toString(8),
			plainFile: paradisRecursiveModeFor(0o4755, false, 0o644).toString(8),
			stickyFile: paradisRecursiveModeFor(0o1777, false, 0o666).toString(8),
		}, {
			setgidFolder: 0o2775,
			executableFile: '775',
			plainFile: '644',
			stickyFile: '666',
		});
	});

	test('accepts only integer modes within 0..07777', () => {
		assert.deepStrictEqual([0, 0o755, 0o7777, 0o10000, -1, 1.5, Number.NaN].map(paradisIsValidMode), [true, true, true, false, false, false, false]);
	});
});
