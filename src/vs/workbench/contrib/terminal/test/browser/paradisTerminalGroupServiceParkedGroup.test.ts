/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ITerminalGroup } from '../../browser/terminal.js';
import { TerminalGroupService } from '../../browser/terminalGroupService.js';

suite('Paradis TerminalGroupService parked group disposal', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createGroup(name: string): ITerminalGroup {
		return upcastPartial<ITerminalGroup>({ title: name, terminalInstances: [], activeInstance: undefined, setVisible: () => { } });
	}

	test('keeps the active tab of the current space when a parked group of another space is disposed', () => {
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IContextKeyService, store.add(new MockContextKeyService()));
		instantiationService.stub(IViewsService, upcastPartial<IViewsService>({ isViewVisible: () => false }));
		instantiationService.stub(IViewDescriptorService, upcastPartial<IViewDescriptorService>({}));
		instantiationService.stub(IQuickInputService, upcastPartial<IQuickInputService>({ onShow: Event.None, onHide: Event.None }));
		const service = store.add(instantiationService.createInstance(TerminalGroupService));

		const parked = createGroup('parked');
		const first = createGroup('first');
		const active = createGroup('active');
		service.groups.push(parked, first, active);
		service.setActiveGroupByIndex(2);
		service.paradisParkGroup(parked);

		const groupChanges: string[] = [];
		store.add(service.onDidChangeActiveGroup(group => groupChanges.push(group?.title ?? 'none')));
		// 実物では createGroup が group.onDisposed を onDidDisposeGroup へ転送する
		(service as unknown as { readonly _onDidDisposeGroup: Emitter<ITerminalGroup> })._onDidDisposeGroup.fire(parked);

		assert.deepStrictEqual({
			groups: service.groups.map(group => group.title),
			parked: service.paradisParkedGroups.map(group => group.title),
			active: service.activeGroup?.title,
			groupChanges,
		}, {
			groups: ['first', 'active'],
			parked: [],
			active: 'active',
			groupChanges: [],
		});
	});
});
