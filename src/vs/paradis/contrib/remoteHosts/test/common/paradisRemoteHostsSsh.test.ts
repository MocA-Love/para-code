/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisIsSafeSshHost, paradisParseSshListing } from '../../common/paradisRemoteHosts.js';

suite('paradisParseSshListing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('sorts directories first, drops dot entries, and reports truncation', () => {
		const listing = ['NOTES.md', 'src/', '.git/', 'package.json', './', '../', 'Makefile'].join('\n');
		deepStrictEqual(paradisParseSshListing(listing, 100), {
			entries: [
				{ name: '.git', isDirectory: true },
				{ name: 'src', isDirectory: true },
				{ name: 'Makefile', isDirectory: false },
				{ name: 'NOTES.md', isDirectory: false },
				{ name: 'package.json', isDirectory: false },
			],
			truncated: false,
		});
	});

	test('keeps only the first entries once the cap is hit, and says so', () => {
		// 上限で切ったことは呼び出し元へ伝える。黙って切ると「そこまでしか無い」と読めてしまう
		const listing = ['a/', 'b/', 'c', 'd'].join('\n');
		deepStrictEqual(paradisParseSshListing(listing, 2), {
			entries: [{ name: 'a', isDirectory: true }, { name: 'b', isDirectory: true }],
			truncated: true,
		});
	});

	test('survives CRLF output and a trailing newline without inventing empty rows', () => {
		deepStrictEqual(paradisParseSshListing('src/\r\nREADME.md\r\n', 100), {
			entries: [{ name: 'src', isDirectory: true }, { name: 'README.md', isDirectory: false }],
			truncated: false,
		});
	});
});

suite('paradisIsSafeSshHost', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts config aliases but refuses anything ssh could read as an option', () => {
		deepStrictEqual([
			paradisIsSafeSshHost('gpu01'),
			paradisIsSafeSshHost('build-box.example.com'),
			paradisIsSafeSshHost('user@host'),
			// ここから下は通してはいけないもの。先頭のハイフンはオプションとして解釈され、
			// ProxyCommand を差し込まれると任意コマンドが走る
			paradisIsSafeSshHost('-oProxyCommand=touch /tmp/pwned'),
			// 単体オプションも宛先として渡してはいけない (文字クラス末尾の `-` は
			// リテラルのハイフンなので、素朴に書くとここが通ってしまう)
			paradisIsSafeSshHost('-G'),
			paradisIsSafeSshHost('-oFoo'),
			paradisIsSafeSshHost('host; rm -rf /'),
			paradisIsSafeSshHost('host name'),
			paradisIsSafeSshHost(''),
			paradisIsSafeSshHost('   '),
		], [true, true, true, false, false, false, false, false, false, false]);
	});
});
