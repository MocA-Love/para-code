/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisRemoteClaudeModBlockedByPolicy } from '../../node/paradisRemoteClaudeMod.server.js';

suite('paradisRemoteClaudeModBlockedByPolicy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads remote-settings.json in each Claude Code config folder on the host, and refuses hosts that are not macOS or Linux', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-claude-mod-'));
		try {
			const plain = join(root, 'plain');
			const forbidden = join(root, 'forbidden');
			const allowedExplicitly = join(root, 'allowed');
			await fs.mkdir(plain, { recursive: true });
			await fs.mkdir(forbidden, { recursive: true });
			await fs.mkdir(allowedExplicitly, { recursive: true });
			await fs.writeFile(join(forbidden, 'remote-settings.json'), '{"disableSideloadFlags":true}');
			await fs.writeFile(join(allowedExplicitly, 'remote-settings.json'), '{"disableSideloadFlags":false}');
			// この機械の /etc/claude-code が mod を禁じていれば、どれも true になる
			const machine = await paradisRemoteClaudeModBlockedByPolicy('linux', root, []);
			assert.deepStrictEqual({
				plain: await paradisRemoteClaudeModBlockedByPolicy('linux', root, [plain]),
				forbidden: await paradisRemoteClaudeModBlockedByPolicy('linux', root, [plain, forbidden]),
				allowedExplicitly: await paradisRemoteClaudeModBlockedByPolicy('linux', root, [allowedExplicitly]),
				windows: await paradisRemoteClaudeModBlockedByPolicy('win32', root, [plain]),
			}, { plain: machine, forbidden: true, allowedExplicitly: machine, windows: true });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
