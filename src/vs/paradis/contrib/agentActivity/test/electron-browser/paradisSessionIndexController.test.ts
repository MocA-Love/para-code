/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { PARADIS_SESSION_INDEX_SETTING_ENABLED } from '../../common/paradisSessionIndex.js';
import { ParadisSessionIndexController } from '../../electron-browser/paradisSessionIndexController.js';

suite('ParadisSessionIndexController', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('is on without any setting and without asking, turns off only when the setting is false, and leaves short terms to the old search', async () => {
		const calls: string[] = [];
		const channel = { call: async (command: string) => { calls.push(command); return { covered: [], matches: [] }; }, listen: () => { throw new Error('unused'); } } as unknown as IChannel;
		const configuration = new TestConfigurationService();
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IConfigurationService, configuration);
		instantiation.stub(ILogService, new NullLogService());
		instantiation.stub(ISharedProcessService, { getChannel: () => channel } as unknown as ISharedProcessService);
		const controller = store.add(instantiation.createInstance(ParadisSessionIndexController));

		const byDefault = controller.state;
		controller.requestUpdate();
		const updatingByDefault = controller.isUpdating;
		await Promise.resolve();
		await configuration.setUserConfiguration(PARADIS_SESSION_INDEX_SETTING_ENABLED, false);
		const off = controller.state;
		const searchWhenOff = await controller.search('needle', ['c']);
		await configuration.setUserConfiguration(PARADIS_SESSION_INDEX_SETTING_ENABLED, true);
		// 3文字未満の語は trigram に掛からず索引全体をなめることになるので、索引を使わない
		const shortTerm = await controller.search('設定 needle', ['c']);
		const searched = await controller.search('needle', ['c']);
		assert.deepStrictEqual({ byDefault, updatingByDefault, off, searchWhenOff, shortTerm, searched, calls }, {
			byDefault: 'on', updatingByDefault: true, off: 'off', searchWhenOff: undefined, shortTerm: undefined,
			searched: { covered: [], matches: [] }, calls: ['indexUpdate', 'indexSearch'],
		});
	});
});
