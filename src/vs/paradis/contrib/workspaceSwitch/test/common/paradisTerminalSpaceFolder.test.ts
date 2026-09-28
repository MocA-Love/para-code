/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { errorHandler, setUnexpectedErrorHandler } from '../../../../../base/common/errors.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { paradisPrepareRestartedTerminalLaunch, paradisRegisterRestartedTerminalCwdResolver, paradisResetRestartedTerminalsForTest, paradisWasTerminalShellRestarted } from '../../common/paradisTerminalLaunchPreparers.js';
import { paradisFindTerminalSpaceMismatches, paradisPickRestartedShellScope, paradisRestartedShellRecordScope, paradisSpaceFolderForBackend, paradisUpstreamCwdConfigured } from '../../common/paradisTerminalSpaceFolder.js';

suite('paradisTerminalSpaceFolder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => paradisResetRestartedTerminalsForTest());

	test('picks the owner of a re-created shell from evidence only, strongest first', () => {
		assert.deepStrictEqual({
			all: paradisPickRestartedShellScope({ recorded: 'r', parked: 'p', ledger: 'l', restoreContext: 'c', workingSet: 'w', pinnedWindow: 'x' }),
			noRecord: paradisPickRestartedShellScope({ parked: 'p', ledger: 'l', restoreContext: 'c', workingSet: 'w' }),
			ledgerOverRestore: paradisPickRestartedShellScope({ ledger: 'l', restoreContext: 'c', workingSet: 'w' }),
			restoreOverWorkingSet: paradisPickRestartedShellScope({ restoreContext: 'c', workingSet: 'w', pinnedWindow: 'x' }),
			workingSetOverWindow: paradisPickRestartedShellScope({ workingSet: 'w', pinnedWindow: 'x' }),
			windowOnly: paradisPickRestartedShellScope({ pinnedWindow: 'x' }),
			nothing: paradisPickRestartedShellScope({}),
			// 記録する側は、起こし直したシェルの cwd より容れ物と固定ウィンドウを先に引く。
			recordOwner: paradisRestartedShellRecordScope({ restartOwner: 'o', workingSet: 'w', pinnedWindow: 'x' }),
			recordWorkingSet: paradisRestartedShellRecordScope({ workingSet: 'w', pinnedWindow: 'x' }),
			recordNothing: paradisRestartedShellRecordScope({}),
		}, {
			all: 'r',
			noRecord: 'p',
			ledgerOverRestore: 'l',
			restoreOverWorkingSet: 'c',
			workingSetOverWindow: 'w',
			windowOnly: 'x',
			nothing: undefined,
			recordOwner: 'o',
			recordWorkingSet: 'w',
			recordNothing: undefined,
		});
	});

	test('hands out a space folder only in the form the backend can start a shell in', () => {
		const spaces = [
			{ stateKey: 'local', uri: URI.file('/Users/example/repo') },
			{ stateKey: 'remote', uri: URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/example/repo' }) },
		];
		const folder = (stateKey: string, remoteAuthority: string | undefined) => paradisSpaceFolderForBackend(stateKey, spaces, remoteAuthority)?.toString();
		assert.deepStrictEqual({
			localToLocal: folder('local', undefined),
			remoteToLocal: folder('remote', undefined),
			remoteToRemote: folder('remote', 'SSH-REMOTE+host'),
			remoteToOtherHost: folder('remote', 'ssh-remote+other'),
			localToRemote: folder('local', 'ssh-remote+host'),
			unknown: folder('gone', undefined),
		}, {
			localToLocal: 'file:///Users/example/repo',
			remoteToLocal: undefined,
			remoteToRemote: 'vscode-remote://ssh-remote%2Bhost/home/example/repo',
			remoteToOtherHost: undefined,
			localToRemote: undefined,
			unknown: undefined,
		});
	});

	test('leaves the start folder to upstream when the user set terminal.integrated.cwd', () => {
		assert.deepStrictEqual(
			[paradisUpstreamCwdConfigured(''), paradisUpstreamCwdConfigured('  '), paradisUpstreamCwdConfigured(undefined), paradisUpstreamCwdConfigured('/opt/work')],
			[false, false, false, true],
		);
	});

	test('lists terminals whose working folder lies in another registered space', () => {
		const roots = [
			{ root: '/Users/example/app', stateKey: 'app' },
			{ root: '/Users/example/app-worktrees/feature', stateKey: 'feature' },
			{ root: '/Users/example/lib', stateKey: 'lib' },
		];
		assert.deepStrictEqual(paradisFindTerminalSpaceMismatches([
			{ instanceId: 1, stateKey: 'app', cwd: '/Users/example/lib/src' },
			{ instanceId: 2, stateKey: 'app', cwd: '/Users/example/app/src' },
			// ホームなど、どのスペースにも属さないフォルダは移し先が無いので拾わない。
			{ instanceId: 3, stateKey: 'app', cwd: '/Users/example' },
			{ instanceId: 4, stateKey: undefined, cwd: '/Users/example/lib' },
			{ instanceId: 5, stateKey: 'lib', cwd: undefined },
			// 最長一致: worktree はリポジトリ本体の外に置かれていても中に置かれていても、より深い方を採る。
			{ instanceId: 6, stateKey: 'app', cwd: '/Users/example/app-worktrees/feature' },
		], roots), [
			{ instanceId: 1, stateKey: 'app', cwdStateKey: 'lib' },
			{ instanceId: 6, stateKey: 'app', cwdStateKey: 'feature' },
		]);
	});

	test('starts a re-created shell in the resolved folder and remembers that it was re-created', async () => {
		const seen: string[] = [];
		const registration = paradisRegisterRestartedTerminalCwdResolver(async launch => {
			seen.push(`${launch.instanceId}:${launch.nonce}:${launch.remoteAuthority ?? 'local'}`);
			return launch.instanceId === 1 ? URI.file('/Users/example/space-a') : undefined;
		});
		try {
			const resolved: IShellLaunchConfig = {};
			const unknown: IShellLaunchConfig = {};
			const explicit: IShellLaunchConfig = { cwd: '/Users/example/explicit' };
			await paradisPrepareRestartedTerminalLaunch(resolved, 1, 'nonce-1', undefined);
			await paradisPrepareRestartedTerminalLaunch(unknown, 2, 'nonce-2', 'ssh-remote+host');
			await paradisPrepareRestartedTerminalLaunch(explicit, 3, 'nonce-3', undefined);
			assert.deepStrictEqual({
				resolved: resolved.cwd?.toString(),
				unknown: unknown.cwd,
				explicit: explicit.cwd,
				seen,
				restarted: [1, 2, 3, 4].map(paradisWasTerminalShellRestarted),
			}, {
				resolved: 'file:///Users/example/space-a',
				unknown: undefined,
				// 呼び出し側が決めた開始フォルダには触らない（問い合わせもしない）。
				explicit: '/Users/example/explicit',
				seen: ['1:nonce-1:local', '2:nonce-2:ssh-remote+host'],
				restarted: [true, true, true, false],
			});
		} finally {
			registration.dispose();
		}
	});

	test('still starts the shell when the resolver fails', async () => {
		const registration = paradisRegisterRestartedTerminalCwdResolver(async () => { throw new Error('boom'); });
		const previous = errorHandler.getUnexpectedErrorHandler();
		const errors: string[] = [];
		setUnexpectedErrorHandler(error => errors.push(String(error)));
		try {
			const config: IShellLaunchConfig = {};
			await paradisPrepareRestartedTerminalLaunch(config, 7, 'nonce-7', undefined);
			assert.deepStrictEqual({ cwd: config.cwd, errors }, { cwd: undefined, errors: ['Error: boom'] });
		} finally {
			setUnexpectedErrorHandler(previous);
			registration.dispose();
		}
	});
});
