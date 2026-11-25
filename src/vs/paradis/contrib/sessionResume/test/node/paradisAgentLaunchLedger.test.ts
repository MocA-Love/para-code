/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS } from '../../common/paradisAgentLaunchProfile.js';
import { PARADIS_AGENT_LAUNCH_LEDGER_FILE, ParadisAgentLaunchLedger, paradisAllowedEnvironment, paradisFindAgentProcess, paradisParseProcessRows, paradisProcessEnvironmentWords, paradisReadAgentProcessEnvironment } from '../../node/paradisAgentLaunchLedger.js';
import { ParadisSessionResumeChannel, ParadisSessionResumeService } from '../../node/paradisSessionResumeChannel.js';

suite('ParadisAgentLaunchLedger', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const id = '0f8c2e1a-7d3b-4c5e-9a6f-1b2c3d4e5f60';
	let root: string;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-agent-launch-'));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('finds the agent process nearest to the pane shell and reads only its allow-listed environment', () => {
		const rows = paradisParseProcessRows([
			'  100     1 -zsh',
			'  200   100 claude --model opus',
			'  210   200 /bin/zsh -c claude -p sub',
			'  220   210 claude -p sub',
			'  300     1 -zsh',
			'  310   300 tmux',
			'  320   310 node /usr/local/lib/node_modules/@openai/codex/bin/codex.js --no-daemon',
			'  330   320 /opt/codex/bin/codex --no-daemon',
			'  400     1 claude --other-pane',
			'garbage',
		].join('\n'));
		const args = 'claude --model opus fix CLAUDE_CODE_SIMPLE=1 please\n';
		assert.deepStrictEqual({
			rows: rows.length,
			claude: paradisFindAgentProcess(rows, 100, 'claude'),
			codexThroughWrappers: paradisFindAgentProcess(rows, 300, 'codex'),
			otherAgent: paradisFindAgentProcess(rows, 100, 'codex'),
			noShell: paradisFindAgentProcess(rows, 999, 'claude'),
			// 引数の中の `名前=値`（依頼文）は環境として読まない
			words: paradisProcessEnvironmentWords(args, 'claude --model opus fix CLAUDE_CODE_SIMPLE=1 please TERM=xterm CLAUDE_CODE_NO_FLICKER=1 ANTHROPIC_API_KEY=sk-x\n'),
			mismatch: paradisProcessEnvironmentWords(args, 'other TERM=xterm\n'),
			noArgs: paradisProcessEnvironmentWords('', 'TERM=xterm\n'),
			allowed: paradisAllowedEnvironment('claude', ['TERM=xterm', 'CLAUDE_CODE_NO_FLICKER=1', 'ANTHROPIC_API_KEY=sk-x', 'CLAUDE_CODE_OAUTH_TOKEN=t', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1', '=x', 'CLAUDE_CODE_SIMPLE']),
		}, {
			rows: 9,
			claude: 200,
			codexThroughWrappers: 320,
			otherAgent: undefined,
			noShell: undefined,
			words: ['TERM=xterm', 'CLAUDE_CODE_NO_FLICKER=1', 'ANTHROPIC_API_KEY=sk-x'],
			mismatch: [],
			noArgs: [],
			allowed: { CLAUDE_CODE_NO_FLICKER: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
		});
	});

	test('does not read another process on Windows', async () => {
		assert.deepStrictEqual(await paradisReadAgentProcessEnvironment(process.pid, 'claude', 'win32'), {});
	});

	test('records a launch per conversation, merges the process environment, and answers through the channel', async () => {
		let now = 1_800_000_000_000;
		const asked: [number, string][] = [];
		const environment: Record<string, string> = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CODE_SUBAGENT_MODEL: 'has space', ANTHROPIC_API_KEY: 'sk-secret' };
		const ledger = new ParadisAgentLaunchLedger(root, new NullLogService(), async (shellPid, agent) => { asked.push([shellPid, agent]); return environment; }, () => now);
		const file = join(root, PARADIS_AGENT_LAUNCH_LEDGER_FILE);

		await ledger.record({ agent: 'claude', sessionId: id, commandLine: 'CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS=1 ANTHROPIC_API_KEY=sk-typed claude --dangerously-skip-permissions --model opus', shellPid: 4242 });
		const started = await ledger.profile('claude', id);
		const written = await fs.readFile(file, 'utf8');
		// Para Code が「確認あり」で再開した起動（プロセスの環境は読めなかったとする）
		delete environment.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
		await ledger.record({ agent: 'claude', sessionId: id, commandLine: `claude --permission-mode manual --model sonnet --resume ${id}` });
		const resumed = await ledger.profile('claude', id);
		// 種類の違うコマンド行・対話でない起動・形の違う ID は控えない
		await ledger.record({ agent: 'codex', sessionId: 'c1', commandLine: 'claude --model opus' });
		await ledger.record({ agent: 'claude', sessionId: 'p1', commandLine: 'claude -p hi --model opus' });
		await ledger.record({ agent: 'claude', sessionId: '-bad', commandLine: 'claude --model opus' });
		await ledger.record({ agent: 'codex', sessionId: 'c2', commandLine: 'codex --yolo -m gpt-6.2-sol' });
		const codex = await ledger.profile('codex', 'c2');
		// 手で書き換えられた台帳も、読むたびに許可リストで絞る
		const tampered = JSON.parse(await fs.readFile(file, 'utf8'));
		tampered.entries['claude:t1'] = { env: { ANTHROPIC_API_KEY: 'x', CLAUDE_CODE_SIMPLE: '1' }, flags: { '--model': '$(id)', '--settings': '{}' }, at: now };
		tampered.entries['claude:t2'] = { env: { PATH: '/x' }, flags: {}, at: now };
		tampered.entries['opencode:t3'] = { env: {}, flags: { '--model': 'x' }, at: now };
		await fs.writeFile(file, JSON.stringify(tampered));
		const sanitized = [await ledger.profile('claude', 't1'), await ledger.profile('claude', 't2'), await ledger.profile('opencode', 't3')];
		// 古い会話の控えは、次に書くときに消える。控えるものの無くなった会話も消える
		now += PARADIS_AGENT_LAUNCH_LEDGER_MAX_AGE_MS + 1;
		await ledger.record({ agent: 'claude', sessionId: 'n1', commandLine: 'claude --effort high' });
		await ledger.record({ agent: 'claude', sessionId: 'n2', commandLine: 'claude --effort high' });
		await ledger.record({ agent: 'claude', sessionId: 'n2', commandLine: 'claude' });
		const keys = Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).entries);
		const channel = new ParadisSessionResumeChannel(new ParadisSessionResumeService({ paraCodeDirectory: root }, new NullLogService()));
		await channel.call('test', 'recordAgentLaunch', [{ agent: 'codex', sessionId: 'c3', commandLine: 'codex --profile work' }]);
		await channel.call('test', 'recordAgentLaunch', ['garbage']);

		assert.deepStrictEqual({
			asked: asked[0],
			started,
			secretWritten: /sk-secret|sk-typed|ANTHROPIC|has space/.test(written),
			resumed,
			codex,
			skipped: [await ledger.profile('codex', 'c1'), await ledger.profile('claude', 'p1'), await ledger.profile('claude', '-bad'), await ledger.profile(undefined, 3)],
			sanitized,
			keys,
			viaChannel: [await channel.call('test', 'agentLaunchProfile', ['codex', 'c3']), await channel.call('test', 'agentLaunchProfile', ['codex', 'missing']), await channel.call('test', 'agentLaunchProfile', [])],
			leftovers: (await fs.readdir(root)).filter(name => name.endsWith('.tmp')),
		}, {
			asked: [4242, 'claude'],
			started: { env: { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }, flags: { '--dangerously-skip-permissions': true, '--model': 'opus' } },
			secretWritten: false,
			resumed: { env: { CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS: '1' }, flags: { '--dangerously-skip-permissions': true, '--model': 'sonnet' } },
			codex: { env: {}, flags: { '--dangerously-bypass-approvals-and-sandbox': true, '--model': 'gpt-6.2-sol' } },
			skipped: [undefined, undefined, undefined, undefined],
			sanitized: [{ env: { CLAUDE_CODE_SIMPLE: '1' }, flags: {} }, undefined, undefined],
			keys: ['claude:n1'],
			viaChannel: [{ env: {}, flags: { '--profile': 'work' } }, undefined, undefined],
			leftovers: [],
		});
	});
});
