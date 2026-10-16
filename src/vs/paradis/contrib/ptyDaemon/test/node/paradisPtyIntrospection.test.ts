/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisExec, paradisReadCwd } from '../../node/paradisPtyIntrospection.js';

suite('paradisReadCwd', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	class CountingLogService extends NullLogService {
		errors = 0;
		override error(): void {
			this.errors++;
		}
	}

	// 作業ディレクトリが消えたシェルでは lsof が cwd の行を出さない
	const lsofWithoutCwd: ParadisExec = (_command, _options, callback) => callback(Object.assign(new Error('Command failed'), { code: 1 }), '', '');

	(isMacintosh ? test : test.skip)('reports a shell whose folder is gone once, not on every screen save', async () => {
		const logService = new CountingLogService();
		const pid = 987_654_321;
		const results = [
			await paradisReadCwd(pid, logService, lsofWithoutCwd),
			await paradisReadCwd(pid, logService, lsofWithoutCwd),
			await paradisReadCwd(pid, logService, lsofWithoutCwd),
			await paradisReadCwd(pid + 1, logService, lsofWithoutCwd),
		];
		logService.dispose();
		assert.deepStrictEqual({ results, errors: logService.errors }, { results: [undefined, undefined, undefined, undefined], errors: 2 });
	});
});
