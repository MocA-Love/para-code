/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IBrowserViewModel } from '../../../../../workbench/contrib/browserView/common/browserView.js';
import { IParadisBrowserScopeService, IParadisWorkspaceSwitchService, IParadisWorktreeService } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { ParadisBrowserViewportService } from '../../electron-browser/paradisBrowserViewportService.js';

suite('ParadisBrowserViewportService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('a closed tab leaves nothing in the size, agent change and first-touch ledgers', async () => {
		const storage = disposables.add(new InMemoryStorageService());
		const service = disposables.add(new ParadisBrowserViewportService(
			storage,
			new TestConfigurationService(),
			{ resolveScope: () => ({ kind: 'global' }) } as unknown as IParadisBrowserScopeService,
			{ onDidRetireScope: Event.None, repositories: [] } as unknown as IParadisWorkspaceSwitchService,
			{} as unknown as IParadisWorktreeService,
		));
		const willDispose = disposables.add(new Emitter<void>());
		const model = { id: 'view-1', device: undefined, onWillDispose: willDispose.event, onDidChangeDevice: Event.None, setDevice: async () => { } } as unknown as IBrowserViewModel;
		service.takeInitialViewport(model);
		service.notePaneSize(model.id, { width: 800, height: 600 });
		await service.apply(model, { kind: 'fit' }, { kind: 'agent', agentLabel: 'Claude' });
		const before = { size: service.getPaneSize(model.id), agent: service.getAgentChange(model.id) !== undefined };
		willDispose.fire();
		assert.deepStrictEqual({ before, after: { size: service.getPaneSize(model.id), agent: service.getAgentChange(model.id) } }, {
			before: { size: { width: 800, height: 600 }, agent: true },
			after: { size: undefined, agent: undefined },
		});
	});

	test('removing a named size also clears the global and space defaults that pointed at it', async () => {
		const storage = disposables.add(new InMemoryStorageService());
		const service = disposables.add(new ParadisBrowserViewportService(
			storage,
			new TestConfigurationService(),
			{ resolveScope: () => ({ kind: 'global' }) } as unknown as IParadisBrowserScopeService,
			{ onDidRetireScope: Event.None, repositories: [] } as unknown as IParadisWorkspaceSwitchService,
			{} as unknown as IParadisWorktreeService,
		));
		service.saveSize({ name: 'Phone', width: 390, height: 844 });
		service.saveSize({ name: 'Tablet', width: 820, height: 1180 });
		service.setSpaceDefault('space-a', 'Phone');
		service.setSpaceDefault('space-b', 'Tablet');
		await service.setGlobalDefault('Phone');
		await service.removeSize('Phone');
		assert.deepStrictEqual({
			global: service.getGlobalDefault(),
			spaceA: service.getSpaceDefault('space-a'),
			spaceB: service.getSpaceDefault('space-b'),
			sizes: service.getSizes().map(size => size.name).includes('Phone'),
		}, { global: '', spaceA: undefined, spaceB: 'Tablet', sizes: false });
	});
});
