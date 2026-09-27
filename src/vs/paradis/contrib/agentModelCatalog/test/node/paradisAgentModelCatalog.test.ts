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
import { PARADIS_CLAUDE_MODEL_LIST_ARGS, PARADIS_CLAUDE_NO_SESSION_PERSISTENCE_FLAG } from '../../common/paradisAgentModelCatalog.js';
import { IParadisAgentModelCatalogBackend, ParadisAgentModelCatalogService, paradisProbeClaudeModels, paradisWithPrivateWorkDir } from '../../node/paradisAgentModelCatalog.js';

suite('ParadisAgentModelCatalogService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const state = {
			now: 0,
			versions: { claude: '2.1.283 (Claude Code)', codex: 'codex-cli 0.155.1' } as Record<string, string | undefined>,
			installed: new Set(['claude', 'codex']),
			failProbe: false,
			probes: [] as string[],
			cache: {} as Record<string, unknown>,
		};
		const backend: IParadisAgentModelCatalogBackend = {
			resolve: async agentId => state.installed.has(agentId) ? { command: `/bin/${agentId}`, env: {} } : undefined,
			version: async cli => state.versions[cli.command.slice('/bin/'.length)],
			probe: async (agentId, cli) => {
				state.probes.push(`${agentId}@${state.versions[agentId]}`);
				if (state.failProbe) {
					throw new Error('boom');
				}
				return [{ id: `${agentId}-model-${state.probes.length}`, efforts: [] }];
			},
			readCache: async () => JSON.parse(JSON.stringify(state.cache)),
			writeCache: async cache => { state.cache = JSON.parse(JSON.stringify(cache)); },
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
