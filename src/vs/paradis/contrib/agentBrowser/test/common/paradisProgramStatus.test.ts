/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisProgramStatus, paradisClaudeProcessIdentity, paradisIsSuspendedExitCode, PARADIS_PROGRAM_STATUS_MUTE_MS, PARADIS_PROGRAM_STATUS_WINDOW_MS, ParadisProgramStatusGate, ParadisProgramStatusTracker, paradisCopyProgramStatus, paradisParseProgramStatus, paradisProgramStatusApplies, paradisProgramStatusClosesOnForeground, paradisProgramStatusForeground, paradisProgramStatusToAgentStatus, paradisTrustedCommandLine } from '../../common/paradisProgramStatus.js';

suite('Para Browser Claude Code program status (OSC 7501)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the sequences Claude Code 2.1.295 wrote in a PTY, and ignores subagent rows and other apps', () => {
		// The payloads below are the ones measured on Claude Code 2.1.295 (msg is base64).
		const inputs = {
			query: '?',
			idle: 'state=idle:app=claude-code',
			working: 'state=working:app=claude-code:msg=UmVtb3ZpbmcgdGhlIG5vbmV4aXN0ZW50IGZpbGUgaWYgcHJlc2VudA==',
			permission: 'state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZSBCYXNo',
			question: 'state=blocked:app=claude-code:kind=question:msg=YW5zd2Vy',
			done: 'state=done:app=claude-code',
			clear: 'state=clear',
			clearOneSubagent: 'state=clear:id=a0e56871',
			subagent: 'state=working:app=claude-code:id=a0e56871:title=UmVwbHk=',
			otherApp: 'state=working:app=other-cli',
			unknownState: 'state=sleeping:app=claude-code',
			noState: 'app=claude-code',
		};
		const parsed = Object.fromEntries(Object.entries(inputs).map(([name, data]) => [name, paradisParseProgramStatus(data)]));
		assert.deepStrictEqual(parsed, {
			query: 'query',
			idle: { state: 'idle' },
			working: { state: 'working' },
			permission: { state: 'blocked', kind: 'permission' },
			question: { state: 'blocked', kind: 'question' },
			done: { state: 'done' },
			clear: { state: 'clear' },
			clearOneSubagent: undefined,
			subagent: undefined,
			otherApp: undefined,
			unknownState: undefined,
			noState: undefined,
		});
	});

	test('maps the states onto the pane states the hooks use, and only for panes no hook has reached', () => {
		assert.deepStrictEqual({
			working: paradisProgramStatusToAgentStatus({ state: 'working' }),
			permission: paradisProgramStatusToAgentStatus({ state: 'blocked', kind: 'permission' }),
			question: paradisProgramStatusToAgentStatus({ state: 'blocked', kind: 'question' }),
			auth: paradisProgramStatusToAgentStatus({ state: 'blocked', kind: 'auth' }),
			dialog: paradisProgramStatusToAgentStatus({ state: 'blocked' }),
			done: paradisProgramStatusToAgentStatus({ state: 'done' }),
			error: paradisProgramStatusToAgentStatus({ state: 'error' }),
			idle: paradisProgramStatusToAgentStatus({ state: 'idle' }),
			clear: paradisProgramStatusToAgentStatus({ state: 'clear' }),
			withoutHooks: paradisProgramStatusApplies(false),
			withHooks: paradisProgramStatusApplies(true),
		}, {
			working: 'working',
			permission: 'permission',
			question: 'question',
			auth: 'permission',
			dialog: 'permission',
			done: 'review',
			error: 'review',
			idle: 'idle',
			clear: 'idle',
			withoutHooks: true,
			withHooks: false,
		});
	});

	test('accepts only a well-formed status over IPC', () => {
		assert.deepStrictEqual([
			paradisCopyProgramStatus({ state: 'blocked', kind: 'permission', extra: 1 }),
			paradisCopyProgramStatus({ state: 'done', kind: 'x'.repeat(40) }),
			paradisCopyProgramStatus({ state: 'done', kind: 'a:b' }),
			paradisCopyProgramStatus({ state: 'nope' }),
			paradisCopyProgramStatus('working'),
			paradisCopyProgramStatus(null),
		], [
			{ state: 'blocked', kind: 'permission' },
			{ state: 'done' },
			{ state: 'done' },
			undefined,
			undefined,
			undefined,
		]);
	});

	test('drops an OSC 7501 body longer than 4 KiB without reading it', () => {
		assert.deepStrictEqual([
			paradisParseProgramStatus(`state=working:app=claude-code:msg=${'A'.repeat(5000)}`),
			paradisParseProgramStatus(`?${'x'.repeat(5000)}`),
		], [undefined, undefined]);
	});

	test('answers the query only while Claude Code, or a command whose far side cannot be seen, runs in front', () => {
		assert.deepStrictEqual({
			claude: paradisProgramStatusForeground('claude --model opus', 'zsh'),
			claudePath: paradisProgramStatusForeground('/Users/example/.local/bin/claude', undefined),
			nativeProcessName: paradisProgramStatusForeground(undefined, '2.1.295'),
			ssh: paradisProgramStatusForeground('ssh dev-box', 'ssh'),
			wsl: paradisProgramStatusForeground(undefined, 'wsl.exe'),
			cat: paradisProgramStatusForeground('cat notes.txt', 'cat'),
			gitLog: paradisProgramStatusForeground('git log -p', 'less'),
			shellAtPrompt: paradisProgramStatusForeground(undefined, 'zsh'),
			nothingKnown: paradisProgramStatusForeground(undefined, undefined),
		}, {
			claude: 'claude',
			claudePath: 'claude',
			nativeProcessName: 'claude',
			ssh: 'passthrough',
			wsl: 'passthrough',
			cat: undefined,
			gitLog: undefined,
			shellAtPrompt: undefined,
			nothingKnown: undefined,
		});
	});

	test('output that writes fake OSC 7501 states changes nothing unless the terminal answered a query from Claude Code', () => {
		let now = 1_000_000;
		const gate = new ParadisProgramStatusGate(() => now);
		const permission: IParadisProgramStatus = { state: 'blocked', kind: 'permission' };
		const passed: string[] = [];
		const feed = (label: string, sequence: string, foreground?: 'claude' | 'passthrough') => {
			const parsed = paradisParseProgramStatus(sequence);
			if (parsed === 'query') {
				passed.push(`${label}: ${gate.query(foreground) ? 'answered' : 'not answered'}`);
			} else if (parsed !== undefined) {
				passed.push(`${label}: ${gate.accept(parsed) ? 'passed' : 'dropped'}`);
			}
		};
		// `cat` of a file holding the sequences, in a plain shell pane
		feed('cat state', 'state=blocked:app=claude-code:kind=permission');
		feed('cat query', '?');
		feed('cat state after its own query', 'state=done:app=claude-code');
		// Claude Code starts and asks
		feed('claude query', '?', 'claude');
		feed('claude idle', 'state=idle:app=claude-code');
		feed('claude working', 'state=working:app=claude-code');
		feed('claude working again', 'state=working:app=claude-code:msg=eA==');
		now += 500;
		feed('claude waiting', 'state=blocked:app=claude-code:kind=permission');
		feed('claude clear', 'state=clear');
		feed('after clear', 'state=done:app=claude-code');
		// A flood after a real query: the fifth change within a second is dropped and the pane is muted
		now += 5_000;
		feed('flood query', '?', 'passthrough');
		for (let i = 0; i < 6; i++) {
			feed(`flood ${i}`, i % 2 === 0 ? 'state=working:app=claude-code' : 'state=done:app=claude-code');
		}
		now += PARADIS_PROGRAM_STATUS_MUTE_MS + 1;
		feed('after the mute', 'state=working:app=claude-code');
		// Long silence closes the window
		now += PARADIS_PROGRAM_STATUS_WINDOW_MS + 1;
		feed('after the window', 'state=done:app=claude-code');
		const closedWhileClosed = gate.close();
		assert.deepStrictEqual({ passed, permissionAlone: new ParadisProgramStatusGate(() => now).accept(permission), closedWhileClosed }, {
			passed: [
				'cat state: dropped',
				'cat query: not answered',
				'cat state after its own query: dropped',
				'claude query: answered',
				'claude idle: passed',
				'claude working: passed',
				'claude working again: dropped',
				'claude waiting: passed',
				'claude clear: passed',
				'after clear: dropped',
				'flood query: answered',
				'flood 0: passed',
				'flood 1: passed',
				'flood 2: passed',
				'flood 3: passed',
				'flood 4: dropped',
				'flood 5: dropped',
				'after the mute: passed',
				'after the window: dropped',
			],
			permissionAlone: false,
			closedWhileClosed: false,
		});
	});

	test('a command line the output wrote with OSC 633 ; E (nonce not matched) does not open the gate', () => {
		const foreground = (current: { command?: string; isTrusted?: boolean } | undefined, processName: string) => paradisProgramStatusForeground(paradisTrustedCommandLine(current), processName);
		assert.deepStrictEqual({
			untrustedClaude: foreground({ command: 'claude', isTrusted: false }, 'cat'),
			untrustedVersion: foreground({ command: '1.2.3', isTrusted: false }, 'less'),
			trustMissing: foreground({ command: 'claude' }, 'zsh'),
			trustedClaude: foreground({ command: 'claude --resume', isTrusted: true }, 'zsh'),
			untrustedButProcessIsClaude: foreground({ command: 'cat x', isTrusted: false }, '2.1.295'),
		}, {
			untrustedClaude: undefined,
			untrustedVersion: undefined,
			trustMissing: undefined,
			trustedClaude: 'claude',
			untrustedButProcessIsClaude: 'claude',
		});
	});

	test('the last state dropped by the throttle is passed once after the mute, so a fast working then done does not stay working', () => {
		let now = 0;
		const gate = new ParadisProgramStatusGate(() => now);
		gate.query('claude');
		const results = ['idle', 'working', 'done', 'working', 'done'].map(state => gate.accept({ state: state as 'idle' | 'working' | 'done' }));
		const dueAt = gate.pendingDueAt;
		const early = gate.releasePending();
		now = dueAt!;
		const released = gate.releasePending();
		const again = gate.releasePending();
		assert.deepStrictEqual({ results, dueAt, early, released, again, pendingAfter: gate.pendingDueAt }, {
			results: [true, true, true, true, false],
			dueAt: PARADIS_PROGRAM_STATUS_MUTE_MS,
			early: undefined,
			released: { state: 'done' },
			again: undefined,
			pendingAfter: undefined,
		});
	});

	test('reads the raw foreground process title the pty reports, and closes a terminal without shell integration once it is back at the shell', () => {
		assert.deepStrictEqual({
			claudePathWithArgs: paradisProgramStatusForeground(undefined, '/Users/example/.local/bin/claude --resume'),
			nativeVersion: paradisProgramStatusForeground(undefined, '2.1.295'),
			sshWithHost: paradisProgramStatusForeground(undefined, 'ssh dev-box'),
			// A named terminal keeps showing the old name; the pty title is what counts.
			backAtShell: paradisProgramStatusForeground(undefined, 'zsh'),
			closeAtShellWithoutIntegration: paradisProgramStatusClosesOnForeground(false, 'zsh'),
			closeWhenTitleUnknown: paradisProgramStatusClosesOnForeground(false, undefined),
			keepWhileClaude: paradisProgramStatusClosesOnForeground(false, '2.1.295'),
			keepWithIntegration: paradisProgramStatusClosesOnForeground(true, 'vim'),
		}, {
			claudePathWithArgs: 'claude',
			nativeVersion: 'claude',
			sshWithHost: 'passthrough',
			backAtShell: undefined,
			closeAtShellWithoutIntegration: true,
			closeWhenTitleUnknown: true,
			keepWhileClaude: false,
			keepWithIntegration: false,
		});
	});

	test('a pending state stays pending when it is asked for before the mute ends', () => {
		let now = 0;
		const gate = new ParadisProgramStatusGate(() => now);
		gate.query('claude');
		for (const state of ['idle', 'working', 'done', 'working', 'done'] as const) {
			gate.accept({ state });
		}
		const dueAt = gate.pendingDueAt!;
		now = dueAt - 1;
		const tooEarly = gate.releasePending();
		const stillDue = gate.pendingDueAt;
		now = dueAt;
		assert.deepStrictEqual({ tooEarly, stillDue, released: gate.releasePending() }, { tooEarly: undefined, stillDue: dueAt, released: { state: 'done' } });
	});

	test('closes once a known shell is back in front, even with shell integration, but not for the node of an npm Claude Code', () => {
		const closes = (title: string | undefined) => paradisProgramStatusClosesOnForeground(true, title);
		assert.deepStrictEqual({
			zsh: closes('zsh'),
			loginZsh: closes('-zsh'),
			bashPath: closes('/bin/bash --login'),
			fish: closes('fish'),
			pwshExe: closes('pwsh.exe'),
			npmClaudeNode: closes('node'),
			nativeClaude: closes('2.1.295'),
			ssh: closes('ssh dev-box'),
			unknown: closes(undefined),
		}, {
			zsh: true,
			loginZsh: true,
			bashPath: true,
			fish: true,
			pwshExe: true,
			npmClaudeNode: false,
			nativeClaude: false,
			ssh: false,
			unknown: false,
		});
	});

	test('Ctrl+Z holds the gate and fg with the same Claude Code reopens it without a new query, since Claude Code 2.1.295 does not ask again', () => {
		let now = 0;
		const gate = new ParadisProgramStatusGate(() => now);
		const identity = paradisClaudeProcessIdentity('2.1.295')!;
		const steps: [string, boolean][] = [];
		gate.query('claude');
		steps.push(['working before Ctrl+Z', gate.accept({ state: 'working' })]);
		steps.push(['suspend', gate.suspend(identity)]);
		steps.push(['state while held', gate.accept({ state: 'blocked', kind: 'permission' })]);
		steps.push(['another program comes back', gate.resume('cat')]);
		steps.push(['fg brings the same Claude Code back', gate.resume(identity)]);
		steps.push(['working after fg', gate.accept({ state: 'working' })]);
		steps.push(['suspend again', gate.suspend(identity)]);
		now += PARADIS_PROGRAM_STATUS_WINDOW_MS + 1;
		steps.push(['fg after the hold expired', gate.resume(identity)]);
		gate.query('claude');
		gate.suspend(identity);
		steps.push(['close drops the hold', gate.close()]);
		steps.push(['fg after close', gate.resume(identity)]);
		assert.deepStrictEqual({
			steps,
			identities: ['2.1.295', '/Users/example/.local/bin/claude --resume', 'node', 'zsh', undefined].map(title => paradisClaudeProcessIdentity(title)),
			suspendedCodes: [146, 148, 0, 1, 130, undefined].map(code => paradisIsSuspendedExitCode(code)),
		}, {
			steps: [
				['working before Ctrl+Z', true],
				['suspend', true],
				['state while held', false],
				['another program comes back', false],
				['fg brings the same Claude Code back', true],
				['working after fg', true],
				['suspend again', true],
				['fg after the hold expired', false],
				['close drops the hold', false],
				['fg after close', false],
			],
			identities: ['2.1.295', 'claude', undefined, undefined, undefined],
			suspendedCodes: [true, true, false, false, false, false],
		});
	});

	test('a command run while Claude Code is stopped does not drop the hold (shell integration: open, D;148, D;0, title back)', () => {
		const tracker = new ParadisProgramStatusTracker();
		const log: string[] = [];
		const note = (step: string, value: unknown) => log.push(`${step}: ${String(value)}`);
		note('query', tracker.query('claude', '2.1.295'));
		note('working', tracker.gate.accept({ state: 'working' }));
		note('Ctrl+Z (D;148)', tracker.commandFinished(148));
		note('git status (D;0)', tracker.commandFinished(0));
		note('title git', tracker.foregroundChanged('git', true));
		note('title zsh', tracker.foregroundChanged('zsh', true));
		note('fg (title back)', tracker.foregroundChanged('2.1.295', true));
		note('open after fg', tracker.gate.isOpen);
		note('working after fg', tracker.gate.accept({ state: 'working' }));
		note('/exit then D;0', tracker.commandFinished(0));
		note('open after the real end', tracker.gate.isOpen);
		note('same title again without a query', tracker.foregroundChanged('2.1.295', true));
		note('still closed', tracker.gate.isOpen);
		assert.deepStrictEqual(log, [
			'query: true',
			'working: true',
			'Ctrl+Z (D;148): clear',
			'git status (D;0): undefined',
			'title git: undefined',
			'title zsh: undefined',
			'fg (title back): undefined',
			'open after fg: true',
			'working after fg: true',
			'/exit then D;0: clear',
			'open after the real end: false',
			'same title again without a query: undefined',
			'still closed: false',
		]);
	});

	test('without shell integration the hold survives other programs (zsh, ls, zsh, version number)', () => {
		const tracker = new ParadisProgramStatusTracker();
		const log: string[] = [];
		const note = (step: string, value: unknown) => log.push(`${step}: ${String(value)}`);
		// The title is polled, so at the moment of the answer it can still be the shell.
		note('query while the title is still zsh', tracker.query('claude', 'zsh'));
		note('title becomes Claude Code', tracker.foregroundChanged('2.1.295', false));
		note('Ctrl+Z (title zsh)', tracker.foregroundChanged('zsh', false));
		note('ls', tracker.foregroundChanged('ls', false));
		note('zsh', tracker.foregroundChanged('zsh', false));
		note('fg (version number)', tracker.foregroundChanged('2.1.295', false));
		note('open after fg', tracker.gate.isOpen);
		note('process exit', tracker.processExited());
		note('version number after the exit', tracker.foregroundChanged('2.1.295', false));
		note('open after the exit', tracker.gate.isOpen);
		assert.deepStrictEqual(log, [
			'query while the title is still zsh: true',
			'title becomes Claude Code: undefined',
			'Ctrl+Z (title zsh): clear',
			'ls: undefined',
			'zsh: undefined',
			'fg (version number): undefined',
			'open after fg: true',
			'process exit: clear',
			'version number after the exit: undefined',
			'open after the exit: false',
		]);
	});
});
