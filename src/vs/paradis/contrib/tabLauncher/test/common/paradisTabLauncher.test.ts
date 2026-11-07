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
	paradisStoreLaunchChoice,
	paradisTabLauncherAgents,
	paradisTabLauncherEfforts,
	paradisTabLauncherUrl,
} from '../../common/paradisTabLauncher.js';

suite('paradisTabLauncher', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const custom: IParadisAgentCommandTemplate = { id: 'aider', label: 'Aider', command: 'aider {prompt}' };
	const claude = PARADIS_DEFAULT_AGENT_COMMANDS.find(agent => agent.id === 'claude')!;
	const codex = PARADIS_DEFAULT_AGENT_COMMANDS.find(agent => agent.id === 'codex')!;

	test('lists the agents the mobile launch sheet lists (no Gemini, keeps user-defined ones)', () => {
		assert.deepStrictEqual(paradisTabLauncherAgents([...PARADIS_DEFAULT_AGENT_COMMANDS, custom]).map(agent => agent.id), ['claude', 'codex', 'aider']);
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
			combo: [{ agentId: 'claude', modelId: 'opus', effortId: 'high' }, { agentId: 'claude', modelId: 'opusplan', effortId: 'high' }],
			lunaUltra: [],
			effortOnly: [],
		});
	});
});
