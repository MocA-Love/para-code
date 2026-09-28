/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MOBILE_BUILTIN_REQUEST_KINDS } from '../../common/paradisMobileRequestKinds.js';

/**
 * 登録表が既存の種類を置き換えないための予約の一覧（PARADIS_MOBILE_BUILTIN_REQUEST_KINDS）が、
 * provider のソースにある `msg.t === '…'` を漏れなく含んでいること。provider に種類を足して
 * 一覧を直し忘れると、その種類を別ファイルで登録できてしまう。
 */
suite('ParadisMobileRequestKinds', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('provider の scm / fs の分岐にある種類はすべて予約されている', function () {
		const candidate = fileURLToPath(new URL('../../../../../../../src/vs/paradis/contrib/mobileRelay/electron-browser/paradisMobileWorkspaceProvider.ts', import.meta.url));
		if (!existsSync(candidate)) {
			// ソースの無い場所（配布物など）から実行された場合は照合対象が無い。
			this.skip();
		}
		const source = readFileSync(candidate, 'utf8');
		const kindsIn = (method: string): string[] => {
			const start = source.indexOf(`private async ${method}(`);
			assert.ok(start >= 0, method);
			const end = source.slice(start + 1).search(/\n\t(?:(?:private|public|protected|static|readonly|async|get|set) )*[a-zA-Z]+[(<]/);
			const body = source.slice(start, end < 0 ? undefined : start + 1 + end);
			return [...new Set([...body.matchAll(/msg\.t === '(?<kind>[^']+)'/g)].map(match => match.groups!.kind))].sort();
		};
		const missing = (kinds: string[], reserved: readonly string[]) => kinds.filter(kind => !reserved.includes(kind));
		assert.deepStrictEqual({
			scm: missing(kindsIn('handleScmInbound'), PARADIS_MOBILE_BUILTIN_REQUEST_KINDS.scm),
			fs: missing([...kindsIn('handleFsInbound'), ...kindsIn('handleMobileOfficeInbound')], PARADIS_MOBILE_BUILTIN_REQUEST_KINDS.fs),
			scmFound: kindsIn('handleScmInbound').length > 10,
			fsFound: kindsIn('handleFsInbound').length > 15,
		}, { scm: [], fs: [], scmFound: true, fsFound: true });
	});
});
