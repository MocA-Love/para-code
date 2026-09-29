/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のアカウント追加（`codex login`）の前後。HOME は一時ディレクトリで、本物の codex は起動しない。

import assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisLimitsMonitorService, paradisCodexLoginUrl } from '../../node/paradisLimitsMonitorChannel.js';

class ParadisCodexMissingService extends ParadisLimitsMonitorService {
	protected override async resolveCommand(): Promise<string> {
		throw new Error('codex not found');
	}
}

suite('ParadisLimitsMonitor Codex login', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-login-'));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('removes the new home it created when adding an account fails before codex starts', async () => {
		mkdirSync(join(root, '.codex'));
		writeFileSync(join(root, '.codex', 'config.toml'), 'model = "gpt-5"\n');
		const service = new ParadisCodexMissingService(new NullLogService(), undefined, undefined, () => root);
		const { sessionId } = await service.startCodexLogin(undefined, undefined);
		let state = service.getSetupState(sessionId);
		for (let i = 0; i < 100 && state.phase !== 'error'; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
			state = service.getSetupState(sessionId);
		}
		service.cancelSetup(sessionId);
		service.dispose();
		assert.deepStrictEqual({ phase: state.phase, error: state.error, homes: readdirSync(root).sort(), newHomeLeft: existsSync(join(root, '.codex-2')) }, {
			phase: 'error',
			error: 'codex not found',
			homes: ['.codex'],
			newHomeLeft: false,
		});
	});

	test('takes the login URL only from auth.openai.com itself', () => {
		assert.deepStrictEqual({
			normal: paradisCodexLoginUrl('Open this URL:\nhttps://auth.openai.com/oauth/authorize?client_id=x&state=y\n'),
			quoted: paradisCodexLoginUrl('"https://auth.openai.com/oauth/authorize?a=1"'),
			lookalike: paradisCodexLoginUrl('https://auth.openai.com.example.net/oauth/authorize?a=1\n'),
			userinfo: paradisCodexLoginUrl('https://auth.openai.com@example.net/x\n'),
			none: paradisCodexLoginUrl('Starting local login server...'),
		}, {
			normal: 'https://auth.openai.com/oauth/authorize?client_id=x&state=y',
			quoted: 'https://auth.openai.com/oauth/authorize?a=1',
			lookalike: undefined,
			userinfo: undefined,
			none: undefined,
		});
	});
});
