/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisCommandLineBypassesPermissions } from '../../../agentHibernation/common/paradisAgentHibernation.js';
import { paradisInteractiveAgentCommand } from '../../../mobileRelay/common/paradisAgentCliCommand.js';
import { paradisResumedSessionOfCommand } from '../../../mobileRelay/common/paradisMobileAgentResume.js';
import { PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS, paradisAgentResumeCommandLine, paradisClaudeCodeModeNeedsSettingsFile, paradisClaudeCodeModeSettingsArgument } from '../../common/paradisSessionResume.js';
import { paradisResumeCommandLine } from '../../common/paradisSessionResumeListOptions.js';

suite('ParadisClaudeCodeModeResume', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const id = '0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60';
	const json = `{"env":{"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA":"0","ENABLE_BETA_TRACING_DETAILED":"0","CLAUDE_CODE_EXPERIMENTAL_CODE_MODE":"1"}}`;

	test('the settings are strict JSON without characters that need shell-specific escaping', () => {
		assert.deepStrictEqual({
			text: PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS,
			parsed: JSON.parse(PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS),
			unsafe: /[\s'\\$`!%^&|<>;()*?~#]/.test(PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS),
		}, {
			text: json,
			parsed: { env: { CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '0', ENABLE_BETA_TRACING_DETAILED: '0', CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' } },
			unsafe: false,
		});
	});

	test('quotes the settings per shell: JSON in single quotes for POSIX shells, a file path for PowerShell and cmd, nothing when it cannot', () => {
		const windowsFile = `C:\\Users\\O'Brien \u2019x\\.para-code\\claude-code-mode-resume.settings.json`;
		const argument = (shellType: string | undefined, windows: boolean, settingsFile?: string) => paradisClaudeCodeModeSettingsArgument({ shellType, windows, settingsFile });
		assert.deepStrictEqual({
			posix: ['bash', 'zsh', 'sh', 'ksh', 'csh', 'fish', 'gitbash', 'wsl'].map(shellType => argument(shellType, false)),
			posixIgnoresFile: argument('zsh', false, '/home/me/.para-code/x.json'),
			unknownShell: argument(undefined, false),
			unknownShellOnWindows: argument(undefined, true, windowsFile),
			powershell: argument('pwsh', true, windowsFile),
			powershellOnMac: argument('pwsh', false, '/Users/me/.para-code/claude-code-mode-resume.settings.json'),
			powershellWithoutFile: argument('pwsh', true),
			powershellNewline: argument('pwsh', true, 'C:\\a\nb.json'),
			cmd: argument('cmd', true, 'C:\\Users\\me\\My Files\\.para-code\\claude-code-mode-resume.settings.json'),
			cmdWithoutFile: argument('cmd', true),
			cmdExpanding: ['C:\\%TEMP%\\x.json', 'C:\\a"b\\x.json', 'C:\\a!b\\x.json', 'C:\\a^b\\x.json'].map(file => argument('cmd', true, file)),
			otherShells: ['nu', 'python', 'node', 'claude'].map(shellType => argument(shellType, false, '/x.json')),
			needsFile: ['pwsh', 'cmd', 'zsh', undefined].map(paradisClaudeCodeModeNeedsSettingsFile),
		}, {
			posix: new Array(8).fill(`'${json}'`),
			posixIgnoresFile: `'${json}'`,
			unknownShell: `'${json}'`,
			unknownShellOnWindows: undefined,
			powershell: `'C:\\Users\\O''Brien \u2019\u2019x\\.para-code\\claude-code-mode-resume.settings.json'`,
			powershellOnMac: `'/Users/me/.para-code/claude-code-mode-resume.settings.json'`,
			powershellWithoutFile: undefined,
			powershellNewline: undefined,
			cmd: `"C:\\Users\\me\\My Files\\.para-code\\claude-code-mode-resume.settings.json"`,
			cmdWithoutFile: undefined,
			cmdExpanding: [undefined, undefined, undefined, undefined],
			otherShells: [undefined, undefined, undefined, undefined],
			needsFile: [true, true, false, false],
		});
	});

	test('adds --settings only to Claude Code resumes of Code Mode sessions, before --resume, and keeps the old command when it cannot quote', () => {
		const zsh = { shellType: 'zsh', windows: false };
		assert.deepStrictEqual({
			resume: paradisAgentResumeCommandLine('claude', id, 'resume', { claudeCodeMode: zsh }),
			bypass: paradisAgentResumeCommandLine('claude', id, 'resume', { dangerouslyBypassPermissions: true, claudeCodeMode: zsh }),
			fork: paradisAgentResumeCommandLine('claude', id, 'fork', { claudeCodeMode: zsh }),
			powershell: paradisAgentResumeCommandLine('claude', id, 'resume', { claudeCodeMode: { shellType: 'pwsh', windows: true, settingsFile: 'C:\\Users\\me\\.para-code\\claude-code-mode-resume.settings.json' } }),
			cannotQuote: paradisAgentResumeCommandLine('claude', id, 'resume', { claudeCodeMode: { shellType: 'pwsh', windows: true } }),
			ordinary: paradisAgentResumeCommandLine('claude', id, 'resume'),
			codex: paradisAgentResumeCommandLine('codex', id, 'resume', { claudeCodeMode: zsh }),
			optionLikeId: paradisAgentResumeCommandLine('claude', '--help', 'resume', { claudeCodeMode: zsh }),
			copied: paradisResumeCommandLine({ agent: 'claude', id, cwd: `/work/it's`, codeMode: true }, false),
			copiedOnWindows: paradisResumeCommandLine({ agent: 'claude', id, cwd: 'C:\\work', codeMode: true }, true),
			copiedOrdinary: paradisResumeCommandLine({ agent: 'claude', id, cwd: '/work' }, false),
		}, {
			resume: `claude --permission-mode manual --settings '${json}' --resume ${id}`,
			bypass: `claude --dangerously-skip-permissions --settings '${json}' --resume ${id}`,
			fork: `claude --permission-mode manual --settings '${json}' --resume ${id} --fork-session`,
			powershell: `claude --permission-mode manual --settings 'C:\\Users\\me\\.para-code\\claude-code-mode-resume.settings.json' --resume ${id}`,
			cannotQuote: `claude --permission-mode manual --resume ${id}`,
			ordinary: `claude --permission-mode manual --resume ${id}`,
			codex: paradisAgentResumeCommandLine('codex', id, 'resume'),
			optionLikeId: undefined,
			copied: `cd '/work/it'\\''s' && claude --permission-mode manual --settings '${json}' --resume ${id}`,
			copiedOnWindows: `Set-Location -LiteralPath 'C:\\work'; claude --permission-mode manual --resume ${id}`,
			copiedOrdinary: `cd '/work' && claude --permission-mode manual --resume ${id}`,
		});
	});

	test('Para Code still reads its own Code Mode resume commands: the resumed session, the mode and the permission bypass', () => {
		const zsh = { shellType: 'zsh', windows: false };
		const resume = paradisAgentResumeCommandLine('claude', id, 'resume', { claudeCodeMode: zsh }) ?? '';
		const bypassFork = paradisAgentResumeCommandLine('claude', id, 'fork', { dangerouslyBypassPermissions: true, claudeCodeMode: zsh }) ?? '';
		const withFile = paradisAgentResumeCommandLine('claude', id, 'resume', { claudeCodeMode: { shellType: 'cmd', windows: true, settingsFile: 'C:\\Users\\me\\My Files\\x.json' } }) ?? '';
		assert.deepStrictEqual({
			resume: [paradisResumedSessionOfCommand(resume), paradisInteractiveAgentCommand(resume), paradisCommandLineBypassesPermissions(resume)],
			bypassFork: [paradisResumedSessionOfCommand(bypassFork), paradisInteractiveAgentCommand(bypassFork), paradisCommandLineBypassesPermissions(bypassFork)],
			withFile: [paradisResumedSessionOfCommand(withFile), paradisInteractiveAgentCommand(withFile), paradisCommandLineBypassesPermissions(withFile)],
			// `--settings` の値を位置引数（サブコマンド）として読まない
			settingsBeforeSubcommand: paradisInteractiveAgentCommand(`claude --settings '${json}' mcp list`),
		}, {
			resume: [{ agent: 'claude', sessionId: id }, { agent: 'claude', mode: 'resume' }, false],
			bypassFork: [paradisResumedSessionOfCommand(`claude --resume ${id} --fork-session`), { agent: 'claude', mode: 'fork' }, true],
			withFile: [{ agent: 'claude', sessionId: id }, { agent: 'claude', mode: 'resume' }, false],
			settingsBeforeSubcommand: undefined,
		});
	});
});
