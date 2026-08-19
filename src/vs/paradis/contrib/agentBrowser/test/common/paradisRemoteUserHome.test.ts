/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRemoteUserHome } from '../../common/paradisRemoteUserHome.js';

const AUTHORITY = 'ssh-remote+example.com';
const REMOTE_HOME = URI.from({ scheme: 'vscode-remote', authority: AUTHORITY, path: '/home/example' });

suite('paradisRemoteUserHome', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns the host home only while it really points at the host', () => {
		assert.deepStrictEqual([
			paradisRemoteUserHome(AUTHORITY, REMOTE_HOME)?.toString(),
			// 接続先の環境が取れないと userHome() は手元のホームを返す。これを掴んではいけない
			paradisRemoteUserHome(AUTHORITY, URI.file('/Users/example')),
			// 接続していないウィンドウ
			paradisRemoteUserHome(undefined, URI.file('/Users/example')),
			// 別の接続先のホーム
			paradisRemoteUserHome(AUTHORITY, URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+other', path: '/home/example' })),
			// authority の大小差だけなら同じ接続先とみなす
			paradisRemoteUserHome(AUTHORITY.toUpperCase(), REMOTE_HOME)?.toString(),
		], [
			REMOTE_HOME.toString(),
			undefined,
			undefined,
			undefined,
			REMOTE_HOME.toString(),
		]);
	});
});
