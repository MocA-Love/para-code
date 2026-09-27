/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';
import {
	IParadisAgentModelCatalog,
	paradisApplyDiscoveredModels,
	paradisModelFlagValue,
	paradisParseClaudeModelList,
	paradisParseCodexModelList,
	paradisResolveAgentTemplates,
	paradisSetDiscoveredAgentModels,
} from '../../common/paradisAgentModelCatalog.js';

// Claude Code 2.1.283 の `list_models` の応答（ログイン無しの一時ホームで取得）を縮めたもの
const CLAUDE_STDOUT = JSON.stringify({
	type: 'control_response', response: {
		subtype: 'success', request_id: 'x', response: {
			models: [
				{ value: 'default', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
				{ value: 'cc-update-required-1', displayName: 'Fable 5.2 (disabled)', disabled: true },
				{ value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
			],
		},
	},
}) + '\n';

// Codex 0.155.1 の `model/list` の応答（同上）を縮めたもの
const CODEX_RESULT = {
	data: [
		{ id: 'gpt-6-astra', model: 'gpt-6-astra', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort, description: '' })) },
		{ id: 'gpt-5.5', model: 'gpt-5.5', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort, description: '' })) },
		{ id: 'internal', model: 'internal', hidden: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
	],
	nextCursor: null,
};

suite('ParadisAgentModelCatalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => paradisSetDiscoveredAgentModels([]));

	test('Claude の一覧から default・使えない行を外し、記号入りの id は引用符で包む', () => {
		assert.deepStrictEqual({
			models: paradisParseClaudeModelList(`{"type":"system"}\n${CLAUDE_STDOUT}`),
			oldCli: paradisParseClaudeModelList('{"type":"control_response","response":{"subtype":"error","error":"unknown subtype"}}\n'),
			flags: ['opus', 'opus[1m]', 'rm -rf', 'a$b'].map(paradisModelFlagValue),
		}, {
			models: [
				{ id: 'opus', label: 'opus (Opus 5.5)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ id: 'claude-fable-5-1', label: 'claude-fable-5-1 (Fable 5.1)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ id: 'opus[1m]', label: 'opus[1m] (Opus 5.5 with 1M context)', efforts: ['low', 'high'] },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', efforts: [] },
			],
			oldCli: [],
			flags: ['opus', '"opus[1m]"', undefined, undefined],
		});
	});

	test('既定の定義へ当てはめる: 取れたエージェントだけ置き換え、エフォートの語彙は足りない分だけ足す', () => {
		const catalogs: IParadisAgentModelCatalog[] = [
			{ agentId: 'claude', cliVersion: '2.1.283 (Claude Code)', fetchedAt: 0, models: paradisParseClaudeModelList(CLAUDE_STDOUT) },
			{ agentId: 'codex', cliVersion: 'codex-cli 0.155.1', fetchedAt: 0, models: paradisParseCodexModelList(CODEX_RESULT) },
		];
		const applied = paradisApplyDiscoveredModels(PARADIS_DEFAULT_AGENT_COMMANDS, catalogs);
		const summary = applied.map(agent => ({ id: agent.id, models: agent.models?.map(model => `${model.flag}|${model.defaultEffort ?? '-'}|${(model.efforts ?? []).length}`), efforts: agent.efforts?.map(effort => effort.id) }));
		assert.deepStrictEqual(summary, [
			{
				id: 'claude',
				// 既定の候補にあった opus の既定エフォートは引き継ぐ。一覧に出ない opusplan は残す
				models: ['--model opus|high|5', '--model claude-fable-5-1|-|5', '--model "opus[1m]"|-|2', '--model haiku|-|0', '--model opusplan|high|5'],
				efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
			},
			{
				id: 'codex',
				models: ['--model gpt-6-astra|low|6', '--model gpt-5.5|medium|4'],
				efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
			},
			{ id: 'gemini', models: undefined, efforts: undefined },
		]);
	});

	test('設定を自分で書いている人の定義は変えない。書いていなければ取れた一覧を使い、取れていなければ既定のまま', () => {
		const catalogs: IParadisAgentModelCatalog[] = [{ agentId: 'codex', cliVersion: 'v', fetchedAt: 0, models: paradisParseCodexModelList(CODEX_RESULT) }];
		const codexModels = (configurationService: TestConfigurationService) => paradisResolveAgentTemplates(configurationService).find(agent => agent.id === 'codex')?.models?.map(model => model.id);

		const unset = new TestConfigurationService();
		const before = codexModels(unset);
		paradisSetDiscoveredAgentModels(catalogs);
		const after = codexModels(unset);
		const custom = new TestConfigurationService({ 'paradis.workspaceSwitch.agents': [{ id: 'codex', label: 'Codex', command: 'codex {prompt}', models: [{ id: 'mine', flag: '--model mine' }] }, { id: 'none', label: 'x', command: 'x' }] });

		assert.deepStrictEqual({
			before,
			after,
			custom: paradisResolveAgentTemplates(custom).map(agent => `${agent.id}:${agent.models?.map(model => model.id).join(',')}`),
		}, {
			before: PARADIS_DEFAULT_AGENT_COMMANDS.find(agent => agent.id === 'codex')?.models?.map(model => model.id),
			after: ['gpt-6-astra', 'gpt-5.5'],
			custom: ['codex:mine'],
		});
	});
});
