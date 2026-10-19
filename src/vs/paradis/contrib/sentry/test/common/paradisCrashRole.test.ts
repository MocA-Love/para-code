/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCrashRoleNodeArgs, paradisIsCrashRole } from '../../common/paradisCrashRole.js';

suite('ParadisCrashRole', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Electron の中だけ、入口より先に印を付ける1行を --import で渡す', () => {
		const [flag, url] = paradisCrashRoleNodeArgs('pty-host-daemon', true);
		const prefix = 'data:text/javascript,';

		assert.deepStrictEqual({
			flag,
			prefixed: url.startsWith(prefix),
			code: decodeURIComponent(url.slice(prefix.length)),
			outsideElectron: paradisCrashRoleNodeArgs('pty-host-daemon', false),
			known: paradisIsCrashRole('devtools-mcp'),
			unknown: paradisIsCrashRole('ptyHost'),
		}, {
			flag: '--import',
			prefixed: true,
			code: 'try{process.crashReporter?.addExtraParameter("para_role","pty-host-daemon")}catch{}',
			outsideElectron: [],
			known: true,
			unknown: false,
		});
	});
});
