/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { paradisIsWindowsScriptShim, paradisWrapWindowsScriptShim } from '../../common/paradisWindowsScriptShim.js';

suite('paradisWindowsScriptShim', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('paradisIsWindowsScriptShim', () => {
		test('detects .cmd/.bat shims case-insensitively', () => {
			assert.strictEqual(paradisIsWindowsScriptShim('C:\\bin\\claude.cmd'), true);
			assert.strictEqual(paradisIsWindowsScriptShim('C:\\bin\\CLAUDE.CMD'), true);
			assert.strictEqual(paradisIsWindowsScriptShim('C:\\bin\\setup.bat'), true);
			assert.strictEqual(paradisIsWindowsScriptShim('npx.cmd'), true);
		});

		test('does not match other executables or bare names', () => {
			assert.strictEqual(paradisIsWindowsScriptShim('C:\\bin\\claude.exe'), false);
			assert.strictEqual(paradisIsWindowsScriptShim('C:\\bin\\claude.com'), false);
			assert.strictEqual(paradisIsWindowsScriptShim('rtk'), false);
			assert.strictEqual(paradisIsWindowsScriptShim('/usr/local/bin/ccusage'), false);
			assert.strictEqual(paradisIsWindowsScriptShim('cmd'), false);
			assert.strictEqual(paradisIsWindowsScriptShim(''), false);
		});
	});

	suite('paradisWrapWindowsScriptShim', () => {
		test('returns undefined for non-shim commands', () => {
			assert.strictEqual(paradisWrapWindowsScriptShim('C:\\bin\\claude.exe', ['--version']), undefined);
			assert.strictEqual(paradisWrapWindowsScriptShim('rtk', []), undefined);
		});

		test('wraps a simple invocation without extra quoting', () => {
			const invocation = paradisWrapWindowsScriptShim('C:\\bin\\ccusage.cmd', ['daily', '--json']);
			assert.deepStrictEqual(invocation, {
				file: 'cmd.exe',
				args: ['/d', '/s', '/v:off', '/c', '"C:\\bin\\ccusage.cmd daily --json"'],
			});
		});

		test('quotes command paths containing spaces', () => {
			const invocation = paradisWrapWindowsScriptShim('C:\\Program Files\\nodejs\\ccusage.cmd', ['--version']);
			assert.deepStrictEqual(invocation, {
				file: 'cmd.exe',
				args: ['/d', '/s', '/v:off', '/c', '""C:\\Program Files\\nodejs\\ccusage.cmd" --version"'],
			});
		});

		test('quotes arguments containing spaces', () => {
			const invocation = paradisWrapWindowsScriptShim('C:\\tools\\x.cmd', ['run', 'my folder']);
			assert.deepStrictEqual(invocation, {
				file: 'cmd.exe',
				args: ['/d', '/s', '/v:off', '/c', '"C:\\tools\\x.cmd run "my folder""'],
			});
		});

		test('honors a custom comspec', () => {
			const invocation = paradisWrapWindowsScriptShim('C:\\bin\\x.cmd', [], 'C:\\Windows\\System32\\cmd.exe');
			assert.deepStrictEqual(invocation, {
				file: 'C:\\Windows\\System32\\cmd.exe',
				args: ['/d', '/s', '/v:off', '/c', '"C:\\bin\\x.cmd"'],
			});
		});

		test('escapes embedded quotes following MSVCRT rules', () => {
			// 値の中の引用符は \" へエスケープされる
			const invocation = paradisWrapWindowsScriptShim('C:\\bin\\x.cmd', ['say', 'he said "hi"']);
			assert.deepStrictEqual(invocation?.args[4], '"C:\\bin\\x.cmd say "he said \\"hi\\"""');
		});

		test('doubles backslashes immediately preceding a quote or end of quoted value', () => {
			// 空白を含み末尾がバックスラッシュの値は引用されるため、閉じ引用符の直前で2倍になる
			const invocation = paradisWrapWindowsScriptShim('C:\\bin\\x.cmd', ['--path', 'my dir\\']);
			assert.deepStrictEqual(invocation?.args[4], '"C:\\bin\\x.cmd --path "my dir\\\\""');
		});

		test('quotes arguments containing cmd.exe metacharacters even without whitespace', () => {
			// 空白・引用符が無くても &|<>^() は cmd.exe 自身の区切り文字なので、クォート無しで
			// 通すと /S 付き /C の再パースでコマンド区切りとして解釈されうる(引数注入)。
			for (const dangerous of ['foo&calc&bar', 'a|b', 'a<b', 'a>b', 'a^b', 'a(b)']) {
				const invocation = paradisWrapWindowsScriptShim('C:\\bin\\x.cmd', ['run', dangerous]);
				assert.deepStrictEqual(invocation?.args[4], `"C:\\bin\\x.cmd run "${dangerous}""`, dangerous);
			}
		});

		test('keeps empty argument lists and empty string arguments valid', () => {
			const invocation = paradisWrapWindowsScriptShim('C:\\bin\\x.cmd', []);
			assert.deepStrictEqual(invocation?.args, ['/d', '/s', '/v:off', '/c', '"C:\\bin\\x.cmd"']);

			const withEmptyArg = paradisWrapWindowsScriptShim('C:\\bin\\x.cmd', ['', '--flag']);
			assert.ok(withEmptyArg?.args[4].includes(' "" '), withEmptyArg?.args[4]);
		});
	});
});
