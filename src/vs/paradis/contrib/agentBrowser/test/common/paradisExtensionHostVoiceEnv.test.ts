/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_MCP_PORT_FILE_ENV_VAR, PARADIS_MCP_PORT_FILE_NAME, PARADIS_VOICE_TOKEN_ENV_VAR } from '../../common/paradisAgentBrowser.js';
import { paradisApplyVoiceEnv } from '../../common/paradisExtensionHostVoiceEnvCore.js';

suite('ParadisExtensionHostVoiceEnv', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function apply(getToken: () => Promise<unknown>, userDataPath = '/data'): Promise<Record<string, unknown>> {
		const env: Record<string, unknown> = {};
		await paradisApplyVoiceEnv(env, userDataPath, getToken, 5);
		return env;
	}

	test('adds the port file and the token, and gives up on a shared process that never answers', async () => {
		deepStrictEqual({
			answered: await apply(() => Promise.resolve('token-1')),
			// The shared process failed during init and never replies: the extension host must still start.
			neverAnswers: await apply(() => new Promise<string>(() => { })),
			rejected: await apply(() => Promise.reject(new Error('channel closed'))),
			empty: await apply(() => Promise.resolve('')),
			noUserData: await apply(() => Promise.resolve('token-1'), ''),
		}, {
			answered: { [PARADIS_MCP_PORT_FILE_ENV_VAR]: join('/data', PARADIS_MCP_PORT_FILE_NAME), [PARADIS_VOICE_TOKEN_ENV_VAR]: 'token-1' },
			neverAnswers: {},
			rejected: {},
			empty: {},
			noUserData: {},
		});
	});
});
