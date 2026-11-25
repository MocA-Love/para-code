/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentPaneSession } from '../../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisInteractiveAgentCommand } from '../../../mobileRelay/common/paradisAgentCliCommand.js';
import { paradisResumedSessionOfCommand } from '../../../mobileRelay/common/paradisMobileAgentResume.js';
import {
	IParadisAgentLaunchProfile,
	PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS,
	PARADIS_AGENT_LAUNCH_LEDGER_MAX_ENTRIES,
	paradisAgentLaunchFromCommandLine,
	paradisAgentLaunchesToRecord,
	paradisLaunchAllowList,
	paradisMergeAgentLaunchProfile,
	paradisPruneAgentLaunchLedger,
	paradisSanitizeAgentLaunchProfile,
} from '../../common/paradisAgentLaunchProfile.js';
import { PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS, paradisAgentResumeCommandLine } from '../../common/paradisSessionResume.js';

suite('ParadisAgentLaunchProfile', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const id = '0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60';
	const profile = (env: Record<string, string>, flags: Record<string, string | true>): IParadisAgentLaunchProfile => ({ env, flags });

	test('the allow list names no secrets and leaves out what the CLIs and Para Code set themselves', () => {
		const claude = paradisLaunchAllowList('claude');
		const codex = paradisLaunchAllowList('codex');
		assert.deepStrictEqual({
			secretNames: [...claude.env, ...codex.env].filter(name => /TOKEN|KEY|SECRET|PASSWORD|AUTH/.test(name)),
			foreignNames: [...claude.env.filter(name => !name.startsWith('CLAUDE_CODE_')), ...codex.env.filter(name => !name.startsWith('CODEX_'))],
			claudePrefix: claude.envPrefix,
			claudeFlags: claude.flags,
			codexEnv: codex.env,
			codexFlags: codex.flags,
			// 許可リストに無い名前・秘密の名前・CLI が自分で付ける名前・引用の要る値は落ちる
			sanitized: paradisSanitizeAgentLaunchProfile('claude', {
				env: {
					CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1',
					CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
					CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1',
					CLAUDE_CODE_EXPERIMENTAL_API_KEY: 'x',
					CLAUDE_CODE_EXPERIMENTAL_AUTH_MODE: '1',
					CLAUDE_CODE_OAUTH_TOKEN: 'secret',
					CLAUDE_CODE_SESSION_ID: 'abc',
					CLAUDE_CODE_SSE_PORT: '1234',
					CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
					CLAUDE_CODE_SUBAGENT_MODEL: 'opus; rm -rf x',
					CLAUDE_CODE_EFFORT_LEVEL: '$(id)',
					CLAUDE_CODE_USE_BEDROCK: '',
					ANTHROPIC_API_KEY: 'sk-x',
					CODEX_HOME: '/home/me/.codex',
					PATH: '/usr/bin',
				},
				flags: { '--model': 'opus[1m]', '--effort': 'high low', '--dangerously-skip-permissions': true, '--settings': '{}', '--permission-mode': 'plan', '-m': 'x', '--allow-dangerously-skip-permissions': 'yes' },
			}),
			codexSanitized: paradisSanitizeAgentLaunchProfile('codex', {
				env: { CODEX_HOME: '/x', CODEX_API_KEY: 'k', CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: '1', CLAUDE_CODE_SIMPLE: '1' },
				flags: { '--model': 'gpt-6.2-sol', '--profile': 'work', '--dangerously-bypass-approvals-and-sandbox': true, '--yolo': true, '-c': 'x=y', '--model ': 'x' },
			}),
			garbage: [null, 'x', 3, { env: 'x', flags: [] }].map(raw => paradisSanitizeAgentLaunchProfile('claude', raw)),
		}, {
			secretNames: [],
			foreignNames: [],
			claudePrefix: 'CLAUDE_CODE_EXPERIMENTAL_',
			claudeFlags: ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--model', '--effort'],
			codexEnv: ['CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS'],
			codexFlags: ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--model', '-m', '--profile', '-p'],
			sanitized: profile(
				{ CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
				{ '--dangerously-skip-permissions': true, '--model': 'opus[1m]' }),
			codexSanitized: profile(
				{ CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: '1' },
				{ '--dangerously-bypass-approvals-and-sandbox': true, '--model': 'gpt-6.2-sol', '--profile': 'work' }),
			garbage: new Array(4).fill(profile({}, {})),
		});
	});

	test('reads the allow-listed environment variables and flags from the command line typed in the pane', () => {
		const read = (commandLine: string) => {
			const launch = paradisAgentLaunchFromCommandLine(commandLine);
			return launch === undefined ? undefined : { agent: launch.agent, mode: launch.mode, env: launch.profile.env, flags: launch.profile.flags };
		};
		assert.deepStrictEqual({
			typed: read('CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1 ANTHROPIC_API_KEY=sk-secret claude --dangerously-skip-permissions --model \'opus[1m]\' --effort=high'),
			plain: read('claude'),
			resume: read(`claude --permission-mode manual --model sonnet --resume ${id}`),
			fork: read(`/opt/bin/claude --resume ${id} --fork-session --dangerously-skip-permissions`),
			// 値を取るオプションの値と、`--` の後ろ（依頼文）はフラグとして読まない
			optionValue: read('claude --append-system-prompt --dangerously-skip-permissions --model opus'),
			afterDoubleDash: read('claude --model opus -- --dangerously-skip-permissions'),
			promptText: read('claude "please run with --dangerously-skip-permissions"'),
			valueless: read('claude --dangerously-skip-permissions=1 --model'),
			codex: read('CODEX_HOME=/x CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS=1 codex --yolo -m gpt-6.2-sol -p work -c model_reasoning_effort=high'),
			codexResume: read(`codex resume --dangerously-bypass-approvals-and-sandbox ${id}`),
			codexFork: read(`codex fork --sandbox workspace-write --ask-for-approval on-request ${id}`),
			notInteractive: ['claude -p hi', 'claude --version', 'codex exec x', 'claude attach abc', 'ls --model x', 'claude mcp list'].map(read),
		}, {
			typed: { agent: 'claude', mode: 'new', env: { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1' }, flags: { '--dangerously-skip-permissions': true, '--effort': 'high', '--model': 'opus[1m]' } },
			plain: { agent: 'claude', mode: 'new', env: {}, flags: {} },
			resume: { agent: 'claude', mode: 'resume', env: {}, flags: { '--model': 'sonnet' } },
			fork: { agent: 'claude', mode: 'fork', env: {}, flags: { '--dangerously-skip-permissions': true } },
			optionValue: { agent: 'claude', mode: 'new', env: {}, flags: { '--model': 'opus' } },
			afterDoubleDash: { agent: 'claude', mode: 'new', env: {}, flags: { '--model': 'opus' } },
			promptText: { agent: 'claude', mode: 'new', env: {}, flags: {} },
			valueless: { agent: 'claude', mode: 'new', env: {}, flags: {} },
			codex: { agent: 'codex', mode: 'new', env: { CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: '1' }, flags: { '--dangerously-bypass-approvals-and-sandbox': true, '--model': 'gpt-6.2-sol', '--profile': 'work' } },
			codexResume: { agent: 'codex', mode: 'resume', env: {}, flags: { '--dangerously-bypass-approvals-and-sandbox': true } },
			codexFork: { agent: 'codex', mode: 'fork', env: {}, flags: {} },
			notInteractive: new Array(6).fill(undefined),
		});
	});

	test('a launch that starts a conversation replaces the record; a resume keeps an existing record and never adds what widens permissions', () => {
		const started = profile({ CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_CODE_SIMPLE: '1' }, { '--dangerously-skip-permissions': true, '--model': 'opus' });
		const confirmed = profile({ CLAUDE_CODE_NO_FLICKER: '1' }, { '--model': 'sonnet' });
		const bypassed = profile({ CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1' }, { '--dangerously-skip-permissions': true, '--allow-dangerously-skip-permissions': true, '--effort': 'high' });
		assert.deepStrictEqual({
			newReplaces: paradisMergeAgentLaunchProfile(started, confirmed, 'new'),
			forkReplaces: paradisMergeAgentLaunchProfile(undefined, bypassed, 'fork'),
			// 再開の起動は、会話を始めたときの控えを変えない（素のコマンドで再開しても消えない）
			resumeKeepsBypass: paradisMergeAgentLaunchProfile(started, confirmed, 'resume'),
			// 「権限確認なしで再開」を選んだだけでは、確認ありで始めた会話を確認なしにしない
			resumeDoesNotAddBypass: paradisMergeAgentLaunchProfile(confirmed, bypassed, 'resume'),
			resumeWithoutRecord: paradisMergeAgentLaunchProfile(undefined, bypassed, 'resume'),
		}, {
			newReplaces: confirmed,
			forkReplaces: bypassed,
			resumeKeepsBypass: started,
			resumeDoesNotAddBypass: confirmed,
			resumeWithoutRecord: profile({}, { '--effort': 'high' }),
		});
	});

	test('puts the record back on the resume command per shell, and Para Code still reads the command as a resume', () => {
		const launched = profile(
			{ CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
			{ '--dangerously-skip-permissions': true, '--allow-dangerously-skip-permissions': true, '--model': 'opus[1m]', '--effort': 'high' });
		const confirmed = profile({ CLAUDE_CODE_SIMPLE: '1' }, { '--model': 'sonnet' });
		const codexLaunched = profile({ CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS: '1' }, { '--dangerously-bypass-approvals-and-sandbox': true, '--model': 'gpt-6.2-sol', '--profile': 'work' });
		const claude = (shellType: string | undefined, windows: boolean, record = launched, mode: 'resume' | 'fork' = 'resume') =>
			paradisAgentResumeCommandLine('claude', id, mode, { launch: { profile: record, shellType, windows } });
		const env = 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 ';
		const quoted = `claude --dangerously-skip-permissions --allow-dangerously-skip-permissions --model 'opus[1m]' --effort high --resume ${id}`;
		const bare = `claude --dangerously-skip-permissions --allow-dangerously-skip-permissions --model opus[1m] --effort high --resume ${id}`;
		const posix = claude('zsh', false)!;
		const withCodeMode = paradisAgentResumeCommandLine('claude', id, 'resume', {
			claudeCodeMode: { shellType: 'zsh', windows: false },
			launch: { profile: profile({ CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1', CLAUDE_CODE_SIMPLE: '1' }, {}), shellType: 'zsh', windows: false },
		})!;
		assert.deepStrictEqual({
			posix: ['bash', 'zsh', 'sh', 'ksh', 'fish', 'gitbash', 'wsl'].map(shellType => claude(shellType, false)),
			unknownShell: claude(undefined, false),
			// csh・PowerShell・cmd・種類の分からない Windows のシェルには、環境変数を付けない（フラグだけ）
			csh: claude('csh', false),
			powershell: claude('pwsh', true),
			cmd: claude('cmd', true),
			unknownShellOnWindows: claude(undefined, true),
			nushell: claude('nu', false),
			// 確認ありで始めた会話は、確認ありのまま
			confirmed: claude('zsh', false, confirmed),
			fork: claude('zsh', false, confirmed, 'fork'),
			// 「権限確認なしで再開」は、控えが無くても確認なし
			explicitBypass: paradisAgentResumeCommandLine('claude', id, 'resume', { dangerouslyBypassPermissions: true, launch: { profile: confirmed, shellType: 'zsh', windows: false } }),
			// Code Mode の `--settings` は 1 つだけで、同じ名前を環境変数で重ねない
			withCodeMode,
			settingsCount: withCodeMode.split('--settings').length - 1,
			codex: paradisAgentResumeCommandLine('codex', id, 'resume', { launch: { profile: codexLaunched, shellType: 'bash', windows: false } }),
			codexFork: paradisAgentResumeCommandLine('codex', id, 'fork', { launch: { profile: profile({}, { '--model': 'gpt-6.2-sol' }), shellType: 'pwsh', windows: true } }),
			// ほかのエージェントには付けない
			opencode: paradisAgentResumeCommandLine('opencode', id, 'resume', { launch: { profile: launched, shellType: 'zsh', windows: false } }),
			// 台帳や接続先から来た値は、組み立ての直前にも確かめる
			tampered: paradisAgentResumeCommandLine('claude', id, 'resume', {
				launch: { profile: profile({ CLAUDE_CODE_SIMPLE: '1; rm -rf ~', ANTHROPIC_API_KEY: 'x' }, { '--model': 'a b', '--settings': '{}' }), shellType: 'zsh', windows: false },
			}),
			// Para Code 自身の解析が、付け直したコマンドを再開として読む（ペインの検知・会話の対応が落ちない）
			parsed: [posix, withCodeMode].map(command => ({ command: paradisInteractiveAgentCommand(command), resumed: paradisResumedSessionOfCommand(command)?.sessionId })),
			reread: paradisAgentLaunchFromCommandLine(posix)?.profile,
		}, {
			posix: new Array(7).fill(env + quoted),
			unknownShell: env + quoted,
			csh: quoted,
			powershell: quoted,
			cmd: bare,
			unknownShellOnWindows: bare,
			nushell: `claude --dangerously-skip-permissions --allow-dangerously-skip-permissions --effort high --resume ${id}`,
			confirmed: `CLAUDE_CODE_SIMPLE=1 claude --permission-mode manual --model sonnet --resume ${id}`,
			fork: `CLAUDE_CODE_SIMPLE=1 claude --permission-mode manual --model sonnet --resume ${id} --fork-session`,
			explicitBypass: `CLAUDE_CODE_SIMPLE=1 claude --dangerously-skip-permissions --model sonnet --resume ${id}`,
			withCodeMode: `CLAUDE_CODE_SIMPLE=1 claude --permission-mode manual --settings '${PARADIS_CLAUDE_CODE_MODE_RESUME_SETTINGS}' --resume ${id}`,
			settingsCount: 1,
			codex: `CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS=1 codex resume --dangerously-bypass-approvals-and-sandbox --model gpt-6.2-sol --profile work ${id}`,
			codexFork: `codex fork --sandbox workspace-write --ask-for-approval on-request --model gpt-6.2-sol ${id}`,
			opencode: `opencode --session ${id}`,
			tampered: `claude --permission-mode manual --resume ${id}`,
			parsed: new Array(2).fill({ command: { agent: 'claude', mode: 'resume' }, resumed: id }),
			reread: launched,
		});
	});

	test('drops old records and keeps the newest when the ledger is full', () => {
		const now = 1_800_000_000_000;
		const entry = (at: number) => ({ env: {}, flags: { '--model': 'opus' }, at });
		const many = Object.fromEntries(Array.from({ length: PARADIS_AGENT_LAUNCH_LEDGER_MAX_ENTRIES + 5 }, (_, index) => [`claude:s${index}`, entry(now - index)]));
		const pruned = paradisPruneAgentLaunchLedger(many, now);
		assert.deepStrictEqual({
			aged: Object.keys(paradisPruneAgentLaunchLedger({ 'claude:new': entry(now - 1000), 'claude:edge': entry(now - PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS), 'codex:old': entry(now - PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS - 1) }, now)),
			count: Object.keys(pruned).length,
			newestKept: pruned['claude:s0'] !== undefined,
			oldestDropped: pruned[`claude:s${PARADIS_AGENT_LAUNCH_LEDGER_MAX_ENTRIES + 4}`] === undefined,
		}, {
			aged: ['claude:new', 'claude:edge'],
			count: PARADIS_AGENT_LAUNCH_LEDGER_MAX_ENTRIES,
			newestKept: true,
			oldestDropped: true,
		});
	});

	test('reports a pane conversation once its command line is known, and again when its id changes', () => {
		const session = (token: string, agent: IParadisAgentPaneSession['agent'], sessionId: string): IParadisAgentPaneSession => ({ token, agent, sessionId, at: 1 });
		const terminals = new Map<string, { commandLine: string | undefined; shellPid: number | undefined; remote: boolean }>([
			['a', { commandLine: undefined, shellPid: 10, remote: false }],
			['b', { commandLine: 'codex --yolo', shellPid: undefined, remote: true }],
			['c', { commandLine: 'vim', shellPid: 30, remote: false }],
			['e', { commandLine: 'opencode', shellPid: 50, remote: false }],
		]);
		const sent = new Set<string>();
		const step = (sessions: IParadisAgentPaneSession[]) => paradisAgentLaunchesToRecord(sessions, sent, token => terminals.get(token));
		const first = step([session('a', 'claude', 's1'), session('b', 'codex', 't1'), session('c', 'claude', 'u1'), session('d', 'claude', 'v1'), session('e', 'opencode', 'w1')]);
		terminals.set('a', { commandLine: 'claude --model opus', shellPid: 10, remote: false });
		const second = step([session('a', 'claude', 's1'), session('b', 'codex', 't1')]);
		const third = step([session('a', 'claude', 's2'), session('b', 'codex', 't1')]);
		const fourth = step([session('b', 'codex', 't1')]);
		assert.deepStrictEqual({ first, second, third, fourth, sent: [...sent] }, {
			first: [{ agent: 'codex', sessionId: 't1', commandLine: 'codex --yolo', remote: true }],
			second: [{ agent: 'claude', sessionId: 's1', commandLine: 'claude --model opus', shellPid: 10, remote: false }],
			third: [{ agent: 'claude', sessionId: 's2', commandLine: 'claude --model opus', shellPid: 10, remote: false }],
			fourth: [],
			sent: ['b\nt1'],
		});
	});
});
