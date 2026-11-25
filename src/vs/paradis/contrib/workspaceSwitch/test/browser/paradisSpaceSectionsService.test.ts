/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { ParadisSpaceSectionsService } from '../../browser/paradisSpaceSectionsService.js';
import { PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, PARADIS_SPACE_SECTIONS_STORAGE_KEY } from '../../common/paradisSpaceSections.js';
import { IParadisWorkspaceRepository, IParadisWorkspaceSwitchService, IParadisWorktree, IParadisWorktreeService } from '../../common/paradisWorkspaceSwitch.js';

function worktree(name: string, repositoryId = 'repo'): IParadisWorktree {
	return { repositoryId, name, uri: URI.file(`/wt/${name}`) };
}

const key = (name: string) => `worktree:file:///wt/${name}`;

suite('ParadisSpaceSectionsService', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	interface IHarness {
		readonly service: ParadisSpaceSectionsService;
		readonly storage: InMemoryStorageService;
		/** setWorktreeOrder に渡された並び（名前の列） */
		readonly orders: string[][];
		worktrees: IParadisWorktree[];
		complete: boolean;
		repositories: IParadisWorkspaceRepository[];
		readonly onDidChangeRepositories: Emitter<void>;
		stored(): unknown;
	}

	function create(storage = store.add(new InMemoryStorageService())): IHarness {
		const onDidChangeRepositories = store.add(new Emitter<void>());
		const harness: Omit<IHarness, 'service'> = {
			storage,
			orders: [],
			worktrees: [worktree('a'), worktree('b'), worktree('c')],
			complete: true,
			repositories: [{ id: 'repo', name: 'repo', uri: URI.file('/repos/repo') }],
			onDidChangeRepositories,
			stored: () => JSON.parse(storage.get(PARADIS_SPACE_SECTIONS_STORAGE_KEY, StorageScope.WORKSPACE) ?? '{}'),
		};
		const service = store.add(new ParadisSpaceSectionsService(
			storage,
			upcastPartial<IParadisWorkspaceSwitchService>({
				get repositories() { return harness.repositories; },
				onDidChangeRepositories: onDidChangeRepositories.event,
			}),
			upcastPartial<IParadisWorktreeService>({
				getWorktrees: repositoryId => repositoryId === 'repo' ? harness.worktrees : [],
				isWorktreeListComplete: () => harness.complete,
				setWorktreeOrder: (_repositoryId, orderedUris) => {
					harness.orders.push(orderedUris.map(uri => uri.substring(uri.lastIndexOf('/') + 1)));
					// The real service re-sorts its list on the next refresh; do it right away.
					harness.worktrees = orderedUris.map(uri => harness.worktrees.find(candidate => candidate.uri.toString() === uri)!);
				},
			}),
			new NullLogService(),
		));
		return Object.assign(harness, { service });
	}

	test('creating a section from a space moves it there, and the space order follows the list order', () => {
		const harness = create();
		const { service } = harness;
		const doing = service.createSection('repo', ' Doing ', worktree('a'))!;
		const review = service.createSection('repo', 'Review')!;
		service.moveSpaceToSection(worktree('b'), doing, { worktree: worktree('a'), after: false });
		service.moveSpaceToSection(worktree('c'), review);
		assert.deepStrictEqual({
			refused: [service.createSection('repo', '  '), service.createSection('unknown', 'X')],
			sections: service.sectionsOf('repo').map(section => section.name),
			of: [service.sectionOf(worktree('a')) === doing, service.sectionOf(worktree('c')) === review, service.sectionOf({ ...worktree('a'), isMainCheckout: true })],
			ordered: service.orderedWorktrees('repo').map(candidate => candidate.name),
			orders: harness.orders,
			canMove: [service.canMoveSpaceWithinSection(worktree('b'), 1), service.canMoveSpaceWithinSection(worktree('a'), 1), service.canMoveSpaceWithinSection(worktree('c'), -1)],
		}, {
			refused: [undefined, undefined],
			sections: ['Doing', 'Review'],
			of: [true, true, undefined],
			ordered: ['b', 'a', 'c'],
			// a goes last when it enters "doing"; b then lands before a. c is already last.
			orders: [['b', 'c', 'a'], ['c', 'b', 'a'], ['b', 'a', 'c']],
			canMove: [true, false, false],
		});
	});

	test('dropping a space on local takes it out of its section and puts it first; removing a section frees its spaces', () => {
		const harness = create();
		const { service } = harness;
		const doing = service.createSection('repo', 'Doing')!;
		service.moveSpaceToSection(worktree('b'), doing);
		service.moveSpaceToSection(worktree('c'), doing);
		service.setCollapsed(doing, true);
		harness.orders.length = 0;
		service.moveSpaceToSection(worktree('c'), undefined, 'first');
		const afterUnsection = service.orderedWorktrees('repo').map(candidate => candidate.name);
		service.removeSection('repo', doing);
		assert.deepStrictEqual({
			afterUnsection,
			orders: harness.orders,
			sections: service.sectionsOf('repo'),
			collapsed: service.isCollapsed(doing),
			stored: harness.stored(),
			storedCollapsed: harness.storage.get(PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, StorageScope.WORKSPACE),
		}, {
			afterUnsection: ['c', 'a', 'b'],
			orders: [['c', 'a', 'b']],
			sections: [],
			collapsed: false,
			stored: {},
			storedCollapsed: '[]',
		});
	});

	test('assignments of spaces that are gone are pruned on write, but not while the scan is incomplete or the list is empty', () => {
		const storage = store.add(new InMemoryStorageService());
		storage.store(PARADIS_SPACE_SECTIONS_STORAGE_KEY, JSON.stringify({ repo: { sections: [{ id: 'doing', name: 'Doing' }], assignments: { [key('a')]: 'doing', [key('gone')]: 'doing' } } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		const harness = create(storage);
		const { service } = harness;

		// The connection dropped: the scan is incomplete and the list is empty.
		harness.complete = false;
		harness.worktrees = [];
		service.renameSection('repo', 'doing', 'Now');
		const whileDisconnected = harness.stored();

		// The scan finished but found nothing (an empty list is never trusted).
		harness.complete = true;
		service.renameSection('repo', 'doing', 'Still');
		const whileEmpty = harness.stored();

		harness.worktrees = [worktree('a'), worktree('b')];
		service.renameSection('repo', 'doing', 'Doing');
		assert.deepStrictEqual({ whileDisconnected, whileEmpty, afterScan: harness.stored() }, {
			whileDisconnected: { repo: { sections: [{ id: 'doing', name: 'Now' }], assignments: { [key('a')]: 'doing', [key('gone')]: 'doing' } } },
			whileEmpty: { repo: { sections: [{ id: 'doing', name: 'Still' }], assignments: { [key('a')]: 'doing', [key('gone')]: 'doing' } } },
			afterScan: { repo: { sections: [{ id: 'doing', name: 'Doing' }], assignments: { [key('a')]: 'doing' } } },
		});
	});

	test('picks up what another window wrote, does not re-read its own writes, and drops the sections of a removed repository', () => {
		const harness = create();
		const { service, storage } = harness;
		let changes = 0;
		store.add(service.onDidChange(() => changes++));

		// Own write: one change, no second one from the storage notification.
		const doing = service.createSection('repo', 'Doing')!;
		const ownWriteChanges = changes;

		// Another window renames the section, assigns a and closes the section.
		storage.store(PARADIS_SPACE_SECTIONS_STORAGE_KEY, JSON.stringify({ repo: { sections: [{ id: doing, name: 'Job' }], assignments: { [key('a')]: doing } } }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		storage.store(PARADIS_SPACE_SECTIONS_COLLAPSED_STORAGE_KEY, JSON.stringify([doing]), StorageScope.WORKSPACE, StorageTarget.MACHINE);

		// The next write here keeps the other window's changes.
		service.moveSpaceToSection(worktree('b'), doing);
		const afterOtherWindow = { changes, collapsed: service.isCollapsed(doing), stored: harness.stored() };

		// An empty repository list (before it is loaded) drops nothing; a real removal drops the repository's sections.
		harness.repositories = [];
		harness.onDidChangeRepositories.fire();
		const afterEmptyList = Object.keys(harness.stored() as object);
		harness.repositories = [{ id: 'other', name: 'other', uri: URI.file('/repos/other') }];
		harness.onDidChangeRepositories.fire();

		assert.deepStrictEqual({ ownWriteChanges, afterOtherWindow, afterEmptyList, afterRemoval: harness.stored(), collapsed: service.isCollapsed(doing) }, {
			ownWriteChanges: 1,
			afterOtherWindow: { changes: 4, collapsed: true, stored: { repo: { sections: [{ id: doing, name: 'Job' }], assignments: { [key('a')]: doing, [key('b')]: doing } } } },
			afterEmptyList: ['repo'],
			afterRemoval: {},
			collapsed: false,
		});
	});
});
