/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ParadisWorkspaceSectionsService } from '../../browser/paradisWorkspaceSectionsService.js';
import { PARADIS_WORKSPACE_SECTIONS_COLLAPSED_STORAGE_KEY, PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY } from '../../common/paradisWorkspaceSections.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService } from '../../common/paradisWorkspaceSwitch.js';

suite('ParadisWorkspaceSectionsService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(storage: InMemoryStorageService, repositoryIds: string[]): ParadisWorkspaceSectionsService {
		const repositories: IParadisWorkspaceRepository[] = repositoryIds.map(id => ({ id, name: id, uri: URI.file(`/repos/${id}`) }));
		return store.add(new ParadisWorkspaceSectionsService(
			storage,
			upcastPartial<IParadisWorkspaceSwitchService>({ repositories, reorderRepositories: () => { } }),
			new NullLogService(),
		));
	}

	test('picks up what another window wrote, does not re-read its own writes, and prunes assignments of removed projects', () => {
		const storage = store.add(new InMemoryStorageService());
		// An assignment of a project that is no longer in the list.
		storage.store(PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY, JSON.stringify({ sections: [{ id: 'work', name: 'Work' }], assignments: { gone: 'work' } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const service = create(storage, ['a', 'b']);
		let changes = 0;
		store.add(service.onDidChange(() => changes++));

		// Own write: one change, no second one from the storage notification.
		service.moveRepositoryToSection('a', 'work');
		const ownWriteChanges = changes;
		const afterOwnWrite = [...service.state.assignments];

		// Another window renames the section, assigns b and closes the section.
		storage.store(PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY, JSON.stringify({ sections: [{ id: 'work', name: 'Job' }], assignments: { a: 'work', b: 'work' } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storage.store(PARADIS_WORKSPACE_SECTIONS_COLLAPSED_STORAGE_KEY, '["work"]', StorageScope.WORKSPACE, StorageTarget.MACHINE);

		// The next write here keeps the other window's changes.
		service.setSectionColor('work', 'blue');
		assert.deepStrictEqual({
			ownWriteChanges,
			afterOwnWrite,
			changes,
			collapsed: service.isCollapsed('work'),
			stored: JSON.parse(storage.get(PARADIS_WORKSPACE_SECTIONS_STORAGE_KEY, StorageScope.WORKSPACE)!),
		}, {
			ownWriteChanges: 1,
			afterOwnWrite: [['a', 'work']],
			changes: 4,
			collapsed: true,
			stored: { sections: [{ id: 'work', name: 'Job', color: 'blue' }], assignments: { a: 'work', b: 'work' } },
		});
	});
});
