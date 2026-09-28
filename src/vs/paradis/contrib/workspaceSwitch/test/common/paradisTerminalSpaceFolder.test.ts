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
import { paradisChangeDirectoryCommand, paradisPickRestartedShellScope, paradisReviewTerminalSpaces, paradisRestartedShellRecordScope, paradisSpaceFolderForBackend, paradisUpstreamCwdConfigured } from '../../common/paradisTerminalSpaceFolder.js';

suite('paradisTerminalSpaceFolder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => paradisResetRestartedTerminalsForTest());

	test('picks the owner of a re-created shell from evidence only, strongest first', () => {
		assert.deepStrictEqual({
			all: paradisPickRestartedShellScope({ recorded: 'r', parked: 'p', ledger: 'l', restoreContext: 'c', workingSet: 'w', pinnedWindow: 'x' }),
			// 出てきた working set が分かっていれば、台帳や今セッションの記録（復元直後に pid 台帳から
			// 付いた値であり得る）より先に採る。
			workingSetOverLedger: paradisPickRestartedShellScope({ recorded: 'r', parked: 'p', ledger: 'l', workingSet: 'w', pinnedWindow: 'x' }),
			parkedOverLedger: paradisPickRestartedShellScope({ recorded: 'r', parked: 'p', ledger: 'l', pinnedWindow: 'x' }),
			ledgerOverRecord: paradisPickRestartedShellScope({ recorded: 'r', ledger: 'l', pinnedWindow: 'x' }),
			recordOverWindow: paradisPickRestartedShellScope({ recorded: 'r', pinnedWindow: 'x' }),
			windowOnly: paradisPickRestartedShellScope({ pinnedWindow: 'x' }),
			nothing: paradisPickRestartedShellScope({}),
			// 記録する側は、起こし直したシェルの cwd より容れ物と固定ウィンドウを先に引く。
			recordOwner: paradisRestartedShellRecordScope({ restartOwner: 'o', workingSet: 'w', pinnedWindow: 'x' }),
			recordWorkingSet: paradisRestartedShellRecordScope({ workingSet: 'w', pinnedWindow: 'x' }),
			recordNothing: paradisRestartedShellRecordScope({}),
		}, {
			all: 'c',
			workingSetOverLedger: 'w',
			parkedOverLedger: 'p',
			ledgerOverRecord: 'l',
			recordOverWindow: 'r',
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

	// 取り違えは2通り。「所属は正しいがシェルだけ別のフォルダ」と「所属もフォルダも別のスペースに
	// 焼き付き、タブだけ元のスペースに居る」。後者は所属と cwd を比べるだけでは見つからない。
	test('lists terminals whose space, tab location and working folder disagree, with the ways to fix them', () => {
		const roots = [
			{ root: '/Users/example/app', stateKey: 'app' },
			{ root: '/Users/example/app-worktrees/feature', stateKey: 'feature' },
			{ root: '/Users/example/lib', stateKey: 'lib' },
		];
		assert.deepStrictEqual(paradisReviewTerminalSpaces([
			// 所属もタブも app だが、シェルは lib に居る。
			{ instanceId: 1, stateKey: 'app', container: 'app', cwd: '/Users/example/lib/src' },
			// 揃っている。
			{ instanceId: 2, stateKey: 'app', container: 'app', cwd: '/Users/example/app/src' },
			// ホームなど、どのスペースにも属さないフォルダは食い違いではない。
			{ instanceId: 3, stateKey: 'app', container: 'app', cwd: '/Users/example' },
			// 所属もフォルダも lib に焼き付き、タブは app に居る。
			{ instanceId: 4, stateKey: 'lib', container: 'app', cwd: '/Users/example/lib' },
			// パネル（居場所なし）で、所属と cwd が食い違う。最長一致で worktree を採る。
			{ instanceId: 5, stateKey: 'app', container: undefined, cwd: '/Users/example/app-worktrees/feature' },
			// 所属もフォルダも分からないパネルは何もしない。
			{ instanceId: 6, stateKey: undefined, container: undefined, cwd: '/Users/example/lib' },
		], roots), [
			{ instanceId: 1, stateKey: 'app', container: 'app', cwdStateKey: 'lib', actions: [{ kind: 'cd', stateKey: 'app' }, { kind: 'move', stateKey: 'lib' }] },
			{ instanceId: 4, stateKey: 'lib', container: 'app', cwdStateKey: 'lib', actions: [{ kind: 'claim', stateKey: 'app' }, { kind: 'cd', stateKey: 'app' }] },
			{ instanceId: 5, stateKey: 'app', container: undefined, cwdStateKey: 'feature', actions: [{ kind: 'cd', stateKey: 'app' }, { kind: 'move', stateKey: 'feature' }] },
		]);
	});

	test('builds a folder change only in a form the shell will not reinterpret', () => {
		assert.deepStrictEqual({
			zsh: paradisChangeDirectoryCommand('zsh', `/Users/example/R&D C# it's`),
			bash: paradisChangeDirectoryCommand('bash', '/Users/example/$HOME `x`'),
			wsl: paradisChangeDirectoryCommand('wsl', '/home/example/a b'),
			fish: paradisChangeDirectoryCommand('fish', `/Users/example/a\\b's`),
			pwsh: paradisChangeDirectoryCommand('pwsh', `C:\\Users\\example\\it's $(x)`),
			cmd: paradisChangeDirectoryCommand('cmd', 'C:\\Users\\example\\R&D'),
			cmdPercent: paradisChangeDirectoryCommand('cmd', 'C:\\Users\\%USERNAME%'),
			csh: paradisChangeDirectoryCommand('csh', '/Users/example'),
			unknown: paradisChangeDirectoryCommand(undefined, '/Users/example'),
			newline: paradisChangeDirectoryCommand('zsh', '/Users/example/a\nrm -rf ~'),
		}, {
			zsh: `cd '/Users/example/R&D C# it'\\''s'`,
			bash: `cd '/Users/example/$HOME \`x\`'`,
			wsl: `cd '/home/example/a b'`,
			fish: `cd '/Users/example/a\\\\b'\\''s'`,
			pwsh: `Set-Location -LiteralPath 'C:\\Users\\example\\it''s $(x)'`,
			cmd: 'cd /d "C:\\Users\\example\\R&D"',
			cmdPercent: undefined,
			csh: undefined,
			unknown: undefined,
			newline: undefined,
		});
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
