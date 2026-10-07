/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisRunAgentCliOptions } from '../../../../node/paradisAgentCli.js';
import { IParadisClaudeEffortSettings, PARADIS_CLAUDE_MODEL_LIST_ARGS, PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG } from '../../common/paradisAgentModelCatalog.js';
import { IParadisAgentModelCatalogBackend, ParadisAgentModelCatalogService, ParadisModelListUnsupportedError, paradisClaudeConfigDirFor, paradisProbeClaudeModels, paradisWithPrivateWorkDir } from '../../node/paradisAgentModelCatalog.js';

suite('ParadisAgentModelCatalogService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const state = {
			now: 0,
			versions: { claude: '2.1.283 (Claude Code)', codex: 'codex-cli 0.155.1' } as Record<string, string | undefined>,
			installed: new Set(['claude', 'codex']),
			failProbe: false,
			unsupported: false,
			probes: [] as string[],
			cache: {} as Record<string, unknown>,
			claudeSettings: {} as IParadisClaudeEffortSettings,
		};
		const backend: IParadisAgentModelCatalogBackend = {
			resolve: async agentId => state.installed.has(agentId) ? { command: `/bin/${agentId}`, env: {} } : undefined,
			version: async cli => state.versions[cli.command.slice('/bin/'.length)],
			probe: async (agentId, cli) => {
				state.probes.push(`${agentId}@${state.versions[agentId]}`);
				if (state.unsupported) {
					throw new ParadisModelListUnsupportedError('unknown option');
				}
				if (state.failProbe) {
					throw new Error('boom');
				}
				return [{ id: `${agentId}-model-${state.probes.length}`, efforts: [] }];
			},
			readCache: async () => JSON.parse(JSON.stringify(state.cache)),
			writeCache: async cache => { state.cache = JSON.parse(JSON.stringify(cache)); },
			claudeEffortSettings: async () => state.claudeSettings,
			now: () => state.now,
		};
		return { state, backend };
	}

	const ids = (catalogs: { agentId: string; models: readonly { id: string }[] }[]) => catalogs.map(catalog => `${catalog.agentId}:${catalog.models.map(model => model.id).join(',')}`);

	test('版が同じ間は CLI に一覧を聞き直さず、版が変わったら取り直す。取れなければ前回の一覧を返す', async () => {
		const { state, backend } = setup();
		const first = await new ParadisAgentModelCatalogService(backend, new NullLogService()).getCatalogs();

		// shared process を起こし直しても、残した結果を使う
		state.now = 5 * 60 * 1000;
		const restarted = await new ParadisAgentModelCatalogService(backend, new NullLogService()).getCatalogs();

		state.versions.codex = 'codex-cli 0.157.1';
		state.now += 5 * 60 * 1000;
		const upgraded = await new ParadisAgentModelCatalogService(backend, new NullLogService()).getCatalogs();

		state.versions.claude = '2.1.290 (Claude Code)';
		state.failProbe = true;
		state.now += 5 * 60 * 1000;
		const failed = await new ParadisAgentModelCatalogService(backend, new NullLogService()).getCatalogs();

		assert.deepStrictEqual({ first: ids(first), restarted: ids(restarted), upgraded: ids(upgraded), failed: ids(failed), probes: state.probes }, {
			first: ['claude:claude-model-1', 'codex:codex-model-2'],
			restarted: ['claude:claude-model-1', 'codex:codex-model-2'],
			upgraded: ['claude:claude-model-1', 'codex:codex-model-3'],
			failed: ['claude:claude-model-1', 'codex:codex-model-3'],
			probes: ['claude@2.1.283 (Claude Code)', 'codex@codex-cli 0.155.1', 'codex@codex-cli 0.157.1', 'claude@2.1.290 (Claude Code)'],
		});
	});

	test('一覧を返す仕組みが無い版には1時間、ほかの理由で取れなかった版には5分は聞き直さない。版が変われば聞き直す', async () => {
		const { state, backend } = setup();
		state.installed.delete('codex');
		state.unsupported = true;
		const service = new ParadisAgentModelCatalogService(backend, new NullLogService());
		const first = await service.getCatalogs();
		state.now += 30 * 60 * 1000;
		await service.getCatalogs();
		state.unsupported = false;
		state.failProbe = true;
		state.versions.claude = '2.1.290 (Claude Code)';
		state.now += 2 * 60 * 1000;
		await service.getCatalogs();
		state.now += 2 * 60 * 1000;
		await service.getCatalogs();
		state.now += 4 * 60 * 1000;
		await service.getCatalogs();
		assert.deepStrictEqual({ first: ids(first), probes: state.probes }, {
			first: [],
			// 1回目（仕組みが無い）→ 30分後は聞かない → 版が変わって聞く（一時的な失敗）→ 2分後は聞かない → 6分後に聞く
			probes: ['claude@2.1.283 (Claude Code)', 'claude@2.1.290 (Claude Code)', 'claude@2.1.290 (Claude Code)'],
		});
	});

	test('入っていない CLI は返さない。1日経ったら版が同じでも取り直す', async () => {
		const { state, backend } = setup();
		state.installed.delete('claude');
		const service = new ParadisAgentModelCatalogService(backend, new NullLogService());
		const first = await service.getCatalogs();
		state.now = 25 * 60 * 60 * 1000;
		const later = await service.getCatalogs();
		assert.deepStrictEqual({ first: ids(first), later: ids(later), probes: state.probes }, {
			first: ['codex:codex-model-1'],
			later: ['codex:codex-model-2'],
			probes: ['codex@codex-cli 0.155.1', 'codex@codex-cli 0.155.1'],
		});
	});

	test('Claude の「既定」のエフォートは返すたびに設定から当てはめ、キャッシュには残さない', async () => {
		const { state, backend } = setup();
		backend.probe = async agentId => {
			state.probes.push(agentId);
			return agentId === 'claude'
				? [{ id: 'claude-opus-5', resolvedModel: 'claude-opus-5', efforts: ['low', 'medium', 'high'] }, { id: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', efforts: [] }]
				: [{ id: 'gpt-6-astra', efforts: ['low', 'medium'], defaultEffort: 'medium' }];
		};
		state.claudeSettings = { effortLevel: 'high' };
		const first = await new ParadisAgentModelCatalogService(backend, new NullLogService()).getCatalogs();
		state.claudeSettings = { effortLevel: 'high', modelEffortLevels: { 'claude-opus-5': 'low' } };
		const second = await new ParadisAgentModelCatalogService(backend, new NullLogService()).getCatalogs();
		const efforts = (catalogs: typeof first) => catalogs.map(catalog => `${catalog.agentId}:${catalog.models.map(model => `${model.id}=${model.defaultEffort ?? '-'}`).join(',')}`);
		const cachedClaude = (state.cache.claude as { models: { defaultEffort?: string }[] }).models.map(model => model.defaultEffort ?? '-');
		assert.deepStrictEqual({ first: efforts(first), second: efforts(second), cachedClaude, probes: state.probes }, {
			first: ['claude:claude-opus-5=high,haiku=-', 'codex:gpt-6-astra=medium'],
			second: ['claude:claude-opus-5=low,haiku=-', 'codex:gpt-6-astra=medium'],
			cachedClaude: ['-', '-'],
			probes: ['claude', 'codex'],
		});
	});

	test('CLAUDE_CONFIG_DIR の ~ は展開し、使えない値なら既定の場所を使う', () => {
		const fallback = paradisClaudeConfigDirFor({});
		assert.deepStrictEqual(
			[{ CLAUDE_CONFIG_DIR: '~/.claude-work' }, { CLAUDE_CONFIG_DIR: '~' }, { CLAUDE_CONFIG_DIR: '/abs/dir ' }, { CLAUDE_CONFIG_DIR: 'relative' }, { CLAUDE_CONFIG_DIR: '~other/x' }].map(env => paradisClaudeConfigDirFor(env, '/home/me')),
			[join('/home/me', '.claude-work'), join('/home/me'), '/abs/dir', fallback, fallback],
		);
	});

	const CLAUDE_OK = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'x', response: { models: [{ value: 'opus', description: 'Opus 5.5 · x', supportsEffort: true, supportedEffortLevels: ['low'] }] } } }) + '\n';

	test('--no-session-persistence を知らない CLI では、そのフラグだけ外して1回だけ取り直す', async () => {
		const calls: { args: readonly string[]; cwd: string | undefined }[] = [];
		const run = async (_command: string, args: readonly string[], options: IParadisRunAgentCliOptions) => {
			calls.push({ args, cwd: options.cwd });
			return args.includes(PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG)
				? { stdout: '', stderr: `error: unknown option '${PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG}'`, exitCode: 1 }
				: { stdout: CLAUDE_OK, stderr: '', exitCode: 0 };
		};
		const models = await paradisProbeClaudeModels({ command: '/bin/claude', env: {} }, '/work', run);
		assert.deepStrictEqual({ models: models.map(model => model.id), calls }, {
			models: ['opus'],
			calls: [
				{ args: PARADIS_CLAUDE_MODEL_LIST_ARGS, cwd: '/work' },
				{ args: PARADIS_CLAUDE_MODEL_LIST_ARGS.filter(arg => arg !== PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG), cwd: '/work' },
			],
		});
	});

	test('一覧の取り方のオプションを知らない版は、仕組みが無いと知らせる', async () => {
		const failure = await paradisProbeClaudeModels({ command: '/bin/claude', env: {} }, '/work', async () => ({ stdout: '', stderr: `error: unknown option '--input-format'`, exitCode: 1 })).then(() => undefined, error => error);
		assert.deepStrictEqual(failure instanceof ParadisModelListUnsupportedError, true);
	});

	test('ほかの理由で一覧が空なら取り直さない（フラグを外すのは、そのフラグで断られたときだけ）', async () => {
		let count = 0;
		const models = await paradisProbeClaudeModels({ command: '/bin/claude', env: {} }, '/work', async () => {
			count++;
			return { stdout: '{"type":"control_response","response":{"subtype":"error"}}\n', stderr: 'not logged in', exitCode: 0 };
		});
		assert.deepStrictEqual({ models, count }, { models: [], count: 1 });
	});

	test('作業ディレクトリは自分専用で作り、成功しても失敗しても消す', async () => {
		const parent = await fs.mkdtemp(join(tmpdir(), 'paradis-models-test-'));
		try {
			const seen: { path: string; mode: number; empty: boolean }[] = [];
			const inspect = async (workDir: string) => {
				seen.push({ path: workDir, mode: (await fs.stat(workDir)).mode & 0o777, empty: (await fs.readdir(workDir)).length === 0 });
				await fs.writeFile(join(workDir, 'leftover'), 'x');
			};
			const ok = await paradisWithPrivateWorkDir(parent, async workDir => { await inspect(workDir); return 'ok'; });
			const failed = await paradisWithPrivateWorkDir(parent, async workDir => { await inspect(workDir); throw new Error('boom'); }).then(() => 'resolved', (error: Error) => error.message);
			assert.deepStrictEqual({
				ok, failed,
				modes: seen.map(entry => entry.mode),
				empty: seen.map(entry => entry.empty),
				inParent: seen.every(entry => entry.path.startsWith(parent)),
				left: await fs.readdir(parent),
			}, { ok: 'ok', failed: 'boom', modes: [0o700, 0o700], empty: [true, true], inParent: true, left: [] });
		} finally {
			await fs.rm(parent, { recursive: true, force: true });
		}
	});
});
