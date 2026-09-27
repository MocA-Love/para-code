/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisAgentModelCatalogBackend, ParadisAgentModelCatalogService } from '../../node/paradisAgentModelCatalog.js';

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
});
