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
import { IParadisLimitsSetupHandle, IParadisLimitsSetupState } from '../../common/paradisLimitsMonitor.js';
import { ParadisLimitsMonitorChannel, ParadisLimitsMonitorService, paradisCodexLoginUrl } from '../../node/paradisLimitsMonitorChannel.js';

class ParadisCodexMissingService extends ParadisLimitsMonitorService {
	/** codex を探している間に新しいホームへ起きること（書きかけの config.toml など）。 */
	beforeFailure: (() => void) | undefined;

	protected override async resolveCommand(): Promise<string> {
		this.beforeFailure?.();
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

	async function addAccountThatFails(beforeFailure?: () => void): Promise<{ phase: string; error?: string; homes: string[] }> {
		const service = new ParadisCodexMissingService(new NullLogService(), undefined, undefined, () => root);
		service.beforeFailure = beforeFailure;
		const { sessionId } = await service.startCodexLogin(undefined, undefined);
		let state = service.getSetupState(sessionId);
		for (let i = 0; i < 100 && state.phase !== 'error'; i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
			state = service.getSetupState(sessionId);
		}
		service.cancelSetup(sessionId);
		service.dispose();
		return { phase: state.phase, error: state.error, homes: readdirSync(root).sort() };
	}

	test('removes the new home it created when adding an account fails before codex starts', async () => {
		mkdirSync(join(root, '.codex'));
		writeFileSync(join(root, '.codex', 'config.toml'), 'model = "gpt-5"\n');
		const result = await addAccountThatFails();
		assert.deepStrictEqual({ ...result, newHomeLeft: existsSync(join(root, '.codex-2')) }, {
			phase: 'error',
			error: 'codex not found',
			homes: ['.codex'],
			newHomeLeft: false,
		});
	});

	test('removes a half-written config.toml with the new home, but keeps a new home that has anything else', async () => {
		const halfWritten = await addAccountThatFails(() => writeFileSync(join(root, '.codex-2', 'config.toml'), 'mod'));
		const withOther = await addAccountThatFails(() => writeFileSync(join(root, '.codex-2', 'sessions.log'), 'x'));
		assert.deepStrictEqual({ halfWritten: halfWritten.homes, withOther: withOther.homes }, {
			halfWritten: [],
			withOther: ['.codex-2'],
		});
	});

	// 同じ接続先へ繋いだ別のウィンドウ（別の PC を含む）に、ログインの URL を読まれたり手続きを潰されたりしない。
	test('on the host, only the client that started a login can read or cancel it; in the shared process anyone can', async () => {
		const service = new ParadisCodexMissingService(new NullLogService(), undefined, undefined, () => root);
		const channel = new ParadisLimitsMonitorChannel<unknown>(service);
		const waitForError = async (ctx: unknown, sessionId: string) => {
			let state = await channel.call<IParadisLimitsSetupState>(ctx, 'getSetupState', [sessionId]);
			for (let i = 0; i < 100 && state.phase !== 'error'; i++) {
				await new Promise(resolve => setTimeout(resolve, 5));
				state = await channel.call<IParadisLimitsSetupState>(ctx, 'getSetupState', [sessionId]);
			}
			return state.error;
		};
		// REH では全ウィンドウの clientId が同じ 'renderer'。接続（context のオブジェクト）で見分ける
		const windowA = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const windowB = { remoteAuthority: 'ssh-remote+host', clientId: 'renderer' };
		const onHost = await channel.call<IParadisLimitsSetupHandle>(windowA, 'startCodexLogin', []);
		const readByOther = await channel.call<IParadisLimitsSetupState>(windowB, 'getSetupState', [onHost.sessionId]);
		await channel.call(windowB, 'cancelSetup', [onHost.sessionId]);
		const readByOwner = await waitForError(windowA, onHost.sessionId);
		await channel.call(windowA, 'cancelSetup', [onHost.sessionId]);
		const local = await channel.call<IParadisLimitsSetupHandle>('window:1', 'startCodexLogin', []);
		const localReadByOther = await waitForError('window:2', local.sessionId);
		await channel.call('window:2', 'cancelSetup', [local.sessionId]);
		service.dispose();
		assert.deepStrictEqual({ readByOther, readByOwner, localReadByOther }, {
			readByOther: { phase: 'error', error: 'setup session not found' },
			readByOwner: 'codex not found',
			localReadByOther: 'codex not found',
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
