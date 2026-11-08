/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IPreferencesService } from '../../../../../workbench/services/preferences/common/preferences.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { PARADIS_DEFAULT_AGENT_COMMANDS } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';
import { IParadisAgentModelCatalog } from '../../common/paradisAgentModelCatalog.js';
import { ParadisAgentModelCatalogService } from '../../electron-browser/paradisAgentModelCatalog.contribution.js';

suite('ParadisAgentModelCatalogService (window)', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	const catalog = (model: string): IParadisAgentModelCatalog[] => [{ agentId: 'claude', cliVersion: '9.9.9 (Claude Code)', models: [{ id: model, efforts: [] }], fetchedAt: 1 }];

	function unknownChannelError(): Error {
		const error = new Error('Unknown channel: paradisAgentModelCatalog timed out after 1000ms');
		error.name = 'Unknown channel';
		return error;
	}

	/** 手元（shared process）と接続先（REH）のどちらへ何回聞いたか。 */
	function setup(remote: (() => Promise<IParadisAgentModelCatalog[]>) | undefined) {
		const calls: string[] = [];
		const channel = (where: string, answer: () => Promise<IParadisAgentModelCatalog[]>) => ({
			call<T>(command: string): Promise<T> {
				calls.push(`${where}:${command}`);
				return answer() as Promise<T>;
			},
		});
		const service = store.add(new ParadisAgentModelCatalogService(
			{ getChannel: () => channel('local', async () => catalog('local-model')) } as unknown as ISharedProcessService,
			new TestConfigurationService(),
			{} as IDialogService,
			{} as IPreferencesService,
			new NullLogService(),
			{ getConnection: () => remote === undefined ? null : { getChannel: () => channel('remote', remote) } } as unknown as IRemoteAgentService,
		));
		let changes = 0;
		store.add(service.onDidChange(() => changes++));
		return { service, calls, changes: () => changes };
	}

	const claudeModels = (service: ParadisAgentModelCatalogService) => service.getAgentTemplates().find(agent => agent.id === 'claude')?.models?.map(model => model.id);

	test('asks the shared process in a local window, and the remote server in an SSH window', async () => {
		const local = setup(undefined);
		local.service.refresh();
		const ssh = setup(async () => catalog('remote-model'));
		ssh.service.refresh();
		await timeout(0);

		assert.deepStrictEqual({
			local: { calls: local.calls, models: claudeModels(local.service), changes: local.changes() },
			ssh: { calls: ssh.calls, models: claudeModels(ssh.service), changes: ssh.changes() },
		}, {
			local: { calls: ['local:getCatalogs'], models: ['local-model', 'opusplan'], changes: 1 },
			ssh: { calls: ['remote:getCatalogs'], models: ['remote-model', 'opusplan'], changes: 1 },
		});
	});

	test('an older remote server without the channel gets the built-in aliases, not the local list, and is not asked again', async () => {
		const ssh = setup(() => Promise.reject(unknownChannelError()));
		ssh.service.refresh();
		await timeout(0);
		ssh.service.refresh();
		await timeout(0);

		assert.deepStrictEqual({ calls: ssh.calls, templates: ssh.service.getAgentTemplates() }, { calls: ['remote:getCatalogs'], templates: PARADIS_DEFAULT_AGENT_COMMANDS });
	});

	test('a passing failure on the remote server keeps the current candidates and asks again', async () => {
		let fail = false;
		const ssh = setup(async () => {
			if (fail) {
				throw new Error('connection lost');
			}
			return catalog('remote-model');
		});
		ssh.service.refresh();
		await timeout(0);
		fail = true;
		ssh.service.refresh();
		await timeout(0);

		assert.deepStrictEqual({ calls: ssh.calls, models: claudeModels(ssh.service), changes: ssh.changes() }, { calls: ['remote:getCatalogs', 'remote:getCatalogs'], models: ['remote-model', 'opusplan'], changes: 1 });
	});
});
