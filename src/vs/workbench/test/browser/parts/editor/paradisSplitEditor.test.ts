/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { ServiceIdentifier, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IListService } from '../../../../../platform/list/browser/listService.js';
import { SplitEditorAction, SplitEditorOrthogonalAction } from '../../../../browser/parts/editor/editorActions.js';
import { splitEditor } from '../../../../browser/parts/editor/editorCommands.js';
import type { IResolvedEditorCommandsContext } from '../../../../browser/parts/editor/editorCommandsContext.js';
import { GroupDirection, IEditorGroupsService, type IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import { IParadisEditorSplitTerminalService } from '../../../../services/editor/common/paradisEditorSplitTerminalService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';

suite('Paradis split editor terminal dispatch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('all four split directions pass the newly-created exact group after focusing it', async () => {
		const source = { id: 1 } as IEditorGroup;
		const directions = [GroupDirection.RIGHT, GroupDirection.DOWN, GroupDirection.LEFT, GroupDirection.UP];
		const addedDirections: GroupDirection[] = [];
		const dispatchedGroups: IEditorGroup[] = [];
		const sequence: string[] = [];
		let nextGroupId = 2;
		const editorGroupsService = {
			addGroup: (_source: IEditorGroup, direction: GroupDirection) => {
				addedDirections.push(direction);
				const id = nextGroupId++;
				return {
					id,
					focus: () => { sequence.push(`focus:${id}`); },
				} as unknown as IEditorGroup;
			},
		} as Partial<IEditorGroupsService> as IEditorGroupsService;
		const splitTerminalService = {
			_serviceBrand: undefined,
			async openTerminalInGroup(group: IEditorGroup) {
				dispatchedGroups.push(group);
				sequence.push(`dispatch:${group.id}`);
			},
		};
		const accessor = {
			get<T>(service: ServiceIdentifier<T>): T {
				assert.strictEqual(service, IParadisEditorSplitTerminalService);
				return splitTerminalService as unknown as T;
			},
		} as ServicesAccessor;
		const context: IResolvedEditorCommandsContext = {
			groupedEditors: [{ group: source, editors: [] }],
			preserveFocus: false,
		};

		for (const direction of directions) {
			await splitEditor(accessor, editorGroupsService, direction, context);
		}

		assert.deepStrictEqual(addedDirections, directions);
		assert.deepStrictEqual(dispatchedGroups.map(group => group.id), [2, 3, 4, 5]);
		assert.deepStrictEqual(sequence, [
			'focus:2', 'dispatch:2',
			'focus:3', 'dispatch:3',
			'focus:4', 'dispatch:4',
			'focus:5', 'dispatch:5',
		]);
	});

	test('Split Editor and Orthogonal actions dispatch their configured complementary directions through the same helper', async () => {
		for (const [preference, expectedNormal, expectedOrthogonal] of [
			['right', GroupDirection.RIGHT, GroupDirection.DOWN],
			['down', GroupDirection.DOWN, GroupDirection.RIGHT],
		] as const) {
			const directions: GroupDirection[] = [];
			const dispatchedGroups: IEditorGroup[] = [];
			const source = { id: 1, activeEditor: null, editors: [] } as unknown as IEditorGroup;
			let nextId = 2;
			const editorGroupsService = {
				activeGroup: source,
				activeModalEditorPart: undefined,
				getGroup: () => source,
				addGroup: (_source: IEditorGroup, direction: GroupDirection) => {
					directions.push(direction);
					return { id: nextId++, focus() { } } as unknown as IEditorGroup;
				},
			} as Partial<IEditorGroupsService> as IEditorGroupsService;
			const accessor = {
				get<T>(service: ServiceIdentifier<T>): T {
					if (service === IEditorGroupsService) { return editorGroupsService as unknown as T; }
					if (service === IConfigurationService) { return { getValue: () => preference } as unknown as T; }
					if (service === IEditorService) { return {} as T; }
					if (service === IListService) { return { lastFocusedList: undefined } as unknown as T; }
					if (service === IParadisEditorSplitTerminalService) {
						return { openTerminalInGroup: async (group: IEditorGroup) => { dispatchedGroups.push(group); } } as unknown as T;
					}
					throw new Error(`Unexpected service: ${service}`);
				},
			} as ServicesAccessor;

			await new SplitEditorAction().run(accessor);
			await new SplitEditorOrthogonalAction().run(accessor);

			assert.deepStrictEqual(directions, [expectedNormal, expectedOrthogonal]);
			assert.deepStrictEqual(dispatchedGroups.map(group => group.id), [2, 3]);
		}
	});
});
