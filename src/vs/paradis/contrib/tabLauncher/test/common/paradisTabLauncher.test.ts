/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisAgentCommandTemplate, PARADIS_DEFAULT_AGENT_COMMANDS } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';
import {
	paradisMatchLauncherAgents,
	paradisNormalizeLaunchChoice,
	paradisParseStoredLaunchChoices,
	paradisRestoreLaunchChoice,
	paradisStoreLaunchChoice,
	ParadisTabLauncherDeviceCache,
	paradisTabLauncherAgents,
	paradisTabLauncherDevices,
	paradisTabLauncherEfforts,
	paradisTabLauncherRoot,
	paradisTabLauncherUrl,
} from '../../common/paradisTabLauncher.js';

suite('paradisTabLauncher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const custom: IParadisAgentCommandTemplate = { id: 'aider', label: 'Aider', command: 'aider {prompt}' };
	const claude = PARADIS_DEFAULT_AGENT_COMMANDS.find(agent => agent.id === 'claude')!;
	const codex = PARADIS_DEFAULT_AGENT_COMMANDS.find(agent => agent.id === 'codex')!;

	test('lists the agents the mobile launch sheet lists (no Gemini, keeps user-defined ones), plus Antigravity CLI on the PC', () => {
		const gemini: IParadisAgentCommandTemplate = { id: 'gemini', label: 'Gemini CLI', command: 'gemini -i {prompt}' };
		assert.deepStrictEqual(paradisTabLauncherAgents([...PARADIS_DEFAULT_AGENT_COMMANDS, gemini, custom]).map(agent => agent.id), ['claude', 'codex', 'antigravity', 'aider']);
	});

	test('reads stored choices and drops malformed values', () => {
		const raw = JSON.stringify({ claude: { modelId: 'opus', effortId: 7, permissionId: '' }, codex: 'broken', aider: {} });
		assert.deepStrictEqual(paradisParseStoredLaunchChoices(raw), {
			claude: { modelId: 'opus', effortId: undefined, permissionId: undefined },
			aider: { modelId: undefined, effortId: undefined, permissionId: undefined },
		});
		assert.deepStrictEqual(paradisParseStoredLaunchChoices('{not json'), {});
		assert.deepStrictEqual(JSON.parse(paradisStoreLaunchChoice(raw, 'codex', { modelId: 'gpt-6-sol' })).codex, { modelId: 'gpt-6-sol' });
	});

	test('normalizes a choice against the current definition', () => {
		assert.deepStrictEqual({
			unknownModel: paradisNormalizeLaunchChoice(claude, { modelId: 'gone', effortId: 'max', permissionId: 'nope' }),
			keeps: paradisNormalizeLaunchChoice(codex, { modelId: 'gpt-6-sol', effortId: 'ultra', permissionId: 'bypass' }),
			effortNotOnModel: paradisNormalizeLaunchChoice(codex, { modelId: 'gpt-6-luna', effortId: 'ultra' }),
			noPermissions: paradisNormalizeLaunchChoice(custom, undefined),
		}, {
			unknownModel: { modelId: undefined, effortId: 'max', permissionId: 'default' },
			keeps: { modelId: 'gpt-6-sol', effortId: 'ultra', permissionId: 'bypass' },
			effortNotOnModel: { modelId: 'gpt-6-luna', effortId: undefined, permissionId: 'default' },
			noPermissions: { modelId: undefined, effortId: undefined, permissionId: undefined },
		});
	});

	test('does not carry a dangerous permission over from the last launch', () => {
		const dangerFirst: IParadisAgentCommandTemplate = { ...custom, permissions: [{ id: 'yolo', label: 'yolo', flag: '--yolo', danger: true }, { id: 'safe', label: 'safe', flag: '' }] };
		assert.deepStrictEqual({
			claudeSkip: paradisRestoreLaunchChoice(claude, { modelId: 'opus', effortId: 'high', permissionId: 'skip-permissions' }),
			codexBypass: paradisRestoreLaunchChoice(codex, { permissionId: 'bypass' }),
			codexFullAuto: paradisRestoreLaunchChoice(codex, { permissionId: 'full-auto' }),
			dangerFirst: paradisRestoreLaunchChoice(dangerFirst, undefined),
		}, {
			claudeSkip: { modelId: 'opus', effortId: 'high', permissionId: 'default' },
			codexBypass: { modelId: undefined, effortId: undefined, permissionId: 'default' },
			codexFullAuto: { modelId: undefined, effortId: undefined, permissionId: 'full-auto' },
			dangerFirst: { modelId: undefined, effortId: undefined, permissionId: 'safe' },
		});
	});

	test('launches in the root of the current space, not the first workspace folder', () => {
		const spaces = [{ space: 'repo-a', uri: '/a' }, { space: 'worktree:repo-a:feature', uri: '/a-worktrees/feature' }];
		assert.deepStrictEqual([
			paradisTabLauncherRoot('worktree:repo-a:feature', spaces, '/first'),
			paradisTabLauncherRoot(undefined, spaces, '/first'),
			paradisTabLauncherRoot('gone', spaces, '/first'),
			paradisTabLauncherRoot(undefined, spaces, undefined),
		], ['/a-worktrees/feature', '/first', '/first', undefined]);
	});

	test('efforts follow the model', () => {
		assert.deepStrictEqual({
			luna: paradisTabLauncherEfforts(codex, 'gpt-6-luna'),
			none: paradisTabLauncherEfforts(custom, undefined),
			unsupported: paradisTabLauncherEfforts({ ...claude, models: [{ id: 'old', flag: '--model old', efforts: [] }] }, 'old'),
		}, {
			luna: { shown: true, ids: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
			none: { shown: false, ids: [] },
			unsupported: { shown: true, ids: [], defaultEffort: undefined },
		});
	});

	test('recognizes URLs and host names', () => {
		assert.deepStrictEqual(['https://example.com/a', 'localhost:3000', 'example.com/docs', 'opus high', 'README.md', 'example.com', ''].map(paradisTabLauncherUrl), [
			'https://example.com/a', 'http://localhost:3000', 'https://example.com/docs', undefined, undefined, 'https://example.com', undefined,
		]);
	});

	test('matches agents and model/effort combinations', () => {
		const agents = paradisTabLauncherAgents(PARADIS_DEFAULT_AGENT_COMMANDS);
		assert.deepStrictEqual({
			agent: paradisMatchLauncherAgents(agents, 'codex'),
			combo: paradisMatchLauncherAgents(agents, 'opus high'),
			lunaUltra: paradisMatchLauncherAgents(agents, 'luna ultra'),
			effortOnly: paradisMatchLauncherAgents(agents, 'high'),
		}, {
			agent: [{ agentId: 'codex' }],
			combo: [{ agentId: 'claude', modelId: 'opus', effortId: 'high' }, { agentId: 'claude', modelId: 'opusplan', effortId: 'high' }, { agentId: 'antigravity', modelId: 'claude-opus-4-6-thinking', effortId: 'high' }],
			lunaUltra: [],
			// Antigravity CLI のモデル id に high が入っている（エフォートは id で決まるので付けない）
			effortOnly: [{ agentId: 'antigravity', modelId: 'gemini-3.8-flash-high', effortId: undefined }],
		});
	});

	// 「シミュレータを開く ›」: 起動している iOS と動いている Android だけ。iOS は macOS だけ（Android は全 OS）
	test('lists running devices for the simulator submenu and keeps iOS to macOS', () => {
		const ios = [
			{ udid: 'A1B2C3D4-0000-1111-2222-333344445555', name: 'iPhone 18 Pro', runtime: 'iOS 27.2', state: 'Booted' as const },
			{ udid: 'A1B2C3D4-0000-1111-2222-333344446666', name: 'iPad Pro', runtime: 'iOS 27.2', state: 'Shutdown' as const },
		];
		const android = [
			{ serial: 'emulator-5554', name: 'Pixel 9', runtime: '', state: 'device' },
			{ serial: 'emulator-5556', name: 'Pixel 8', runtime: 'Android 15', state: 'offline' },
		];
		assert.deepStrictEqual({
			mac: paradisTabLauncherDevices(ios, android, true),
			other: paradisTabLauncherDevices(ios, android, false),
			none: paradisTabLauncherDevices([], [], true),
		}, {
			mac: [
				{ kind: 'ios', id: 'A1B2C3D4-0000-1111-2222-333344445555', name: 'iPhone 18 Pro', runtime: 'iOS 27.2' },
				{ kind: 'android', id: 'emulator-5554', name: 'Pixel 9', runtime: 'Android' },
			],
			other: [{ kind: 'android', id: 'emulator-5554', name: 'Pixel 9', runtime: 'Android' }],
			none: [],
		});
	});

	// 一覧は › を開いたときに取り、30 秒は取り直さない（⌄ を開くたびに simctl・adb を起こさない）
	test('keeps the device list for a short while', async () => {
		const cache = new ParadisTabLauncherDeviceCache<number>(30_000);
		let loads = 0;
		const load = async () => ++loads;
		const values = [await cache.get(load, 0), await cache.get(load, 29_999), await cache.get(load, 30_000), await cache.get(load, 30_001)];
		assert.deepStrictEqual({ values, loads }, { values: [1, 1, 2, 2], loads: 2 });
	});
});
