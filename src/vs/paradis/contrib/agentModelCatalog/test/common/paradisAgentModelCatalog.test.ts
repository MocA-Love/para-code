/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { stringHash } from '../../../../../base/common/hash.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS, paradisResolveAgentLaunchFlags } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { PARADIS_PAST_DEFAULT_AGENT_COMMANDS } from '../../common/paradisAgentListPastDefaults.js';
import {
	IParadisAgentModelCatalog,
	paradisApplyClaudeDefaultEfforts,
	paradisApplyDiscoveredModels,
	paradisClaudeModelDisplayName,
	paradisIsAgentListUserDefined,
	paradisModelFlagValue,
	paradisParseClaudeModelList,
	paradisParseCodexModelList,
	paradisReadClaudeEffortSettings,
	paradisResolveAgentTemplates,
} from '../../common/paradisAgentModelCatalog.js';

// Claude Code 2.1.283 の `list_models` の応答（ログイン無しの一時ホームで API キーを渡して取得）を縮めたもの。
// sonnet と claude-opus-4-8 の説明文は、サブスクリプションで使っているときの形（階層の説明）にしてある
const CLAUDE_STDOUT = JSON.stringify({
	type: 'control_response', response: {
		subtype: 'success', request_id: 'x', response: {
			models: [
				{ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Most efficient for everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5 with 1M context', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
				{ value: 'cc-update-required-1', displayName: 'Fable 5.2 (disabled)', disabled: true },
				{ value: 'custom-model', displayName: 'Custom', description: 'Most capable for ambitious work' },
				{ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
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

	test('Claude の一覧から default・使えない行を外し、記号入りの id は引用符で包む', () => {
		assert.deepStrictEqual({
			models: paradisParseClaudeModelList(`{"type":"system"}\n${CLAUDE_STDOUT}`),
			oldCli: paradisParseClaudeModelList('{"type":"control_response","response":{"subtype":"error","error":"unknown subtype"}}\n'),
			flags: ['opus', 'opus[1m]', 'rm -rf', 'a$b'].map(paradisModelFlagValue),
		}, {
			models: [
				{ id: 'opus', label: 'opus (Opus 5.5)', resolvedModel: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ id: 'claude-fable-5-1', label: 'claude-fable-5-1 (Fable 5.1)', resolvedModel: 'claude-fable-5-1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ id: 'sonnet', label: 'sonnet (Sonnet 5)', resolvedModel: 'claude-sonnet-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
				{ id: 'opus[1m]', label: 'opus[1m] (Opus 5.5 · 1M)', resolvedModel: 'claude-opus-5-5[1m]', efforts: ['low', 'high'] },
				{ id: 'custom-model', label: 'custom-model (Custom)', efforts: [] },
				{ id: 'haiku', label: 'haiku (Haiku 4.5)', resolvedModel: 'claude-haiku-4-5-20251001', efforts: [] },
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
		const summary = applied.map(agent => ({ id: agent.id, models: agent.models?.map(model => `${model.flag}|${model.defaultEffort ?? '-'}|${(model.efforts ?? []).length}`), efforts: agent.efforts?.map(effort => effort.flag) }));
		assert.deepStrictEqual(summary, [
			{
				id: 'claude',
				// 既定の候補にあった opus / sonnet の既定エフォートは引き継ぐ。一覧に出ない opusplan は残す
				models: ['--model opus|medium|5', '--model claude-fable-5-1|-|5', '--model sonnet|high|5', '--model "opus[1m]"|-|2', '--model custom-model|-|0', '--model haiku|-|0', '--model opusplan|medium|5'],
				efforts: ['--effort low', '--effort medium', '--effort high', '--effort xhigh', '--effort max'],
			},
			{
				id: 'codex',
				models: ['--model gpt-6-astra|low|6', '--model gpt-5.5|medium|4'],
				efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => `-c model_reasoning_effort=${id}`),
			},
			{ id: 'gemini', models: undefined, efforts: undefined },
		]);
	});

	test('Claude の名前は正式なモデル id から作り、既定のエフォートは Claude Code の設定の順で決める', () => {
		const models = paradisParseClaudeModelList(CLAUDE_STDOUT);
		const settings = paradisReadClaudeEffortSettings({ effortLevel: 'high', modelSettings: { 'claude-fable-5-1': { effortLevel: 'low' }, 'claude-haiku-4-5': { effortLevel: 'low' }, broken: 3 } }, undefined);
		const defaults = (list: typeof models) => list.map(model => `${model.id}=${model.defaultEffort ?? '-'}`);
		assert.deepStrictEqual({
			names: ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-4-8[1m]', 'gpt-5.5', 'claude-opus'].map(paradisClaudeModelDisplayName),
			settings,
			fromSettings: defaults(paradisApplyClaudeDefaultEfforts(models, settings)),
			fromEnv: defaults(paradisApplyClaudeDefaultEfforts(models, paradisReadClaudeEffortSettings({ effortLevel: 'high' }, ' xhigh '))),
			none: defaults(paradisApplyClaudeDefaultEfforts(models, paradisReadClaudeEffortSettings(undefined, undefined))),
		}, {
			names: ['Opus 5.5', 'Haiku 4.5', 'Sonnet 5', 'Opus 4.8 · 1M', undefined, undefined],
			settings: { effortLevel: 'high', modelEffortLevels: { 'claude-fable-5-1': 'low', 'claude-haiku-4-5': 'low' } },
			// haiku はエフォート非対応なので設定があっても添えない。opus[1m] は選べる中に high がある
			fromSettings: ['opus=high', 'claude-fable-5-1=low', 'sonnet=high', 'opus[1m]=high', 'custom-model=-', 'haiku=-'],
			fromEnv: ['opus=xhigh', 'claude-fable-5-1=xhigh', 'sonnet=xhigh', 'opus[1m]=-', 'custom-model=-', 'haiku=-'],
			none: ['opus=-', 'claude-fable-5-1=-', 'sonnet=-', 'opus[1m]=-', 'custom-model=-', 'haiku=-'],
		});
	});

	test('設定を自分で書いている人の定義は変えない。書いていなければ取れた一覧を使い、取れていなければ既定のまま', () => {
		const catalogs: IParadisAgentModelCatalog[] = [{ agentId: 'codex', cliVersion: 'v', fetchedAt: 0, models: paradisParseCodexModelList(CODEX_RESULT) }];
		const codexModels = (configurationService: TestConfigurationService, list: readonly IParadisAgentModelCatalog[]) => paradisResolveAgentTemplates(configurationService, list).find(agent => agent.id === 'codex')?.models?.map(model => model.id);

		const unset = new TestConfigurationService();
		const before = codexModels(unset, []);
		const after = codexModels(unset, catalogs);
		const custom = new TestConfigurationService({ 'paradis.workspaceSwitch.agents': [{ id: 'codex', label: 'Codex', command: 'codex {prompt}', models: [{ id: 'mine', flag: '--model mine' }] }, { id: 'none', label: 'x', command: 'x' }] });

		assert.deepStrictEqual({
			before,
			after,
			custom: paradisResolveAgentTemplates(custom, catalogs).map(agent => `${agent.id}:${agent.models?.map(model => model.id).join(',')}`),
		}, {
			before: PARADIS_DEFAULT_AGENT_COMMANDS.find(agent => agent.id === 'codex')?.models?.map(model => model.id),
			after: ['gpt-6-astra', 'gpt-5.5'],
			custom: ['codex:mine'],
		});
	});

	test('今か過去の既定値をそのまま書き写した設定は、書いていないものとして CLI の一覧を使う', () => {
		const catalogs: IParadisAgentModelCatalog[] = [{ agentId: 'codex', cliVersion: 'v', fetchedAt: 0, models: paradisParseCodexModelList(CODEX_RESULT) }];
		const resolve = (value: unknown) => {
			const configurationService = new TestConfigurationService({ 'paradis.workspaceSwitch.agents': value });
			return {
				userDefined: paradisIsAgentListUserDefined(configurationService),
				codex: paradisResolveAgentTemplates(configurationService, catalogs).find(agent => agent.id === 'codex')?.models?.map(model => model.id).join(','),
			};
		};
		const edited = JSON.parse(JSON.stringify(PARADIS_PAST_DEFAULT_AGENT_COMMANDS[2]));
		edited[1].models.pop();
		assert.deepStrictEqual({
			current: resolve(JSON.parse(JSON.stringify(PARADIS_DEFAULT_AGENT_COMMANDS))),
			past: PARADIS_PAST_DEFAULT_AGENT_COMMANDS.map(resolve),
			edited: resolve(edited),
		}, {
			current: { userDefined: false, codex: 'gpt-6-astra,gpt-5.5' },
			past: [
				{ userDefined: false, codex: 'gpt-6-astra,gpt-5.5' },
				{ userDefined: false, codex: 'gpt-6-astra,gpt-5.5' },
				{ userDefined: false, codex: 'gpt-6-astra,gpt-5.5' },
			],
			edited: { userDefined: true, codex: 'gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5' },
		});
	});

	test('利用者が書いた Codex の定義にある --effort と --full-auto は、今の CLI が受け付けるフラグに読み替える', () => {
		const edited = JSON.parse(JSON.stringify(PARADIS_PAST_DEFAULT_AGENT_COMMANDS[2]));
		edited[1].models.pop();
		edited.push({ id: 'mine', label: 'Mine', command: '/opt/bin/codex --full-auto {prompt}' }, { id: 'other', label: 'Other', command: 'other --effort high', efforts: [{ id: 'high', flag: '--effort high' }] });
		const templates = paradisResolveAgentTemplates(new TestConfigurationService({ 'paradis.workspaceSwitch.agents': edited }), []);
		const byId = (id: string) => templates.find(agent => agent.id === id)!;
		assert.deepStrictEqual({
			codex: paradisResolveAgentLaunchFlags(byId('codex'), { modelId: 'gpt-5.6-sol', effortId: 'ultra', permissionId: 'full-auto' }),
			claude: paradisResolveAgentLaunchFlags(byId('claude'), { modelId: 'opus', effortId: 'max' }),
			mine: byId('mine').command,
			other: byId('other').efforts?.map(effort => effort.flag),
		}, {
			codex: { model: '--model gpt-5.6-sol', effort: '-c model_reasoning_effort=ultra', permission: '--sandbox workspace-write --ask-for-approval on-request' },
			claude: { model: '--model opus', effort: '--effort max', permission: '' },
			mine: '/opt/bin/codex --sandbox workspace-write --ask-for-approval on-request {prompt}',
			other: ['--effort high'],
		});
	});

	test('既定の定義を変えたら、変える前の値を過去の既定値（paradisAgentListPastDefaults.ts）の末尾に足す', () => {
		// この指紋が変わったら、変える前の PARADIS_DEFAULT_AGENT_COMMANDS を JSON の形で
		// PARADIS_PAST_DEFAULT_AGENT_COMMANDS へ足してから、ここの値を新しい指紋に書き換える
		assert.strictEqual(stringHash(JSON.stringify(PARADIS_DEFAULT_AGENT_COMMANDS), 0), 361081178);
	});
});
