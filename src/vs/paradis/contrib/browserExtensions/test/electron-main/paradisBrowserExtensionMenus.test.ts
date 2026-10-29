/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	IParadisStoredMenuItem,
	paradisApplyMenuClick,
	paradisArrangeExtensionMenu,
	paradisCreateMenuItem,
	paradisFormatMenuTitle,
	paradisMenuClickData,
	paradisMenuItemProperties,
	paradisMenuTargetFromParams,
	paradisParseShortcut,
	paradisParseStoredMenuItems,
	paradisReadExtensionCommands,
	paradisRemoveMenuItem,
	paradisUpdateMenuItem,
	paradisVisibleMenuTree,
} from '../../common/paradisBrowserExtensionMenus.js';
import { paradisMatchesUrlPattern } from '../../electron-main/paradisBrowserExtensionTabs.js';

function build(...steps: ((items: readonly IParadisStoredMenuItem[]) => readonly IParadisStoredMenuItem[])[]): readonly IParadisStoredMenuItem[] {
	return steps.reduce<readonly IParadisStoredMenuItem[]>((items, step) => step(items), []);
}

function errorOf(run: () => unknown): string | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

suite('ParadisBrowserExtensionMenus model', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps ids unique, removes children with their parent and one checked radio per run', () => {
		const items = build(
			items => paradisCreateMenuItem(items, 'root', { title: 'Root' }),
			items => paradisCreateMenuItem(items, 'a', { title: 'A', type: 'radio', parentId: 'root' }),
			items => paradisCreateMenuItem(items, 'b', { title: 'B', type: 'radio', parentId: 'root', checked: true }),
			items => paradisCreateMenuItem(items, 1, { type: 'separator' }),
		);
		const removed = paradisRemoveMenuItem(items, 'root');
		assert.deepStrictEqual({
			radios: items.filter(item => item.type === 'radio').map(item => [item.id, item.checked]),
			removed: removed.map(item => item.id),
			duplicate: errorOf(() => paradisCreateMenuItem(items, 'a', { title: 'A' })),
			noTitle: errorOf(() => paradisCreateMenuItem(items, 'c', {})),
			noParent: errorOf(() => paradisCreateMenuItem(items, 'c', { title: 'C', parentId: 'nope' })),
			ownChild: errorOf(() => paradisUpdateMenuItem(items, 'root', { parentId: 'a' })),
			missing: errorOf(() => paradisRemoveMenuItem(items, 'nope')),
			badType: errorOf(() => paradisMenuItemProperties({ type: 'button' })),
			badContext: errorOf(() => paradisMenuItemProperties({ contexts: ['everywhere'] })),
			dropsOnclick: paradisMenuItemProperties({ title: 'T', onclick: 'x', unknown: 1 }),
		}, {
			radios: [['a', false], ['b', true]],
			removed: [1],
			duplicate: 'Cannot create item with duplicate id a',
			noTitle: 'Title missing.',
			noParent: 'Cannot find menu item with id nope',
			ownChild: 'Cannot set an item to be a descendant of itself',
			missing: 'Cannot find menu item with id nope',
			badType: `Invalid value for argument 1. Property 'type': Value must be one of normal, checkbox, radio, separator.`,
			badContext: 'Invalid contexts',
			dropsOnclick: { title: 'T' },
		});
	});

	test('a click flips a checkbox and moves the radio selection before onClicked', () => {
		const items = build(
			items => paradisCreateMenuItem(items, 'check', { title: 'Check', type: 'checkbox' }),
			items => paradisCreateMenuItem(items, 'r1', { title: 'One', type: 'radio' }),
			items => paradisCreateMenuItem(items, 'r2', { title: 'Two', type: 'radio' }),
		);
		const checkbox = paradisApplyMenuClick(items, items[0]);
		const radio = paradisApplyMenuClick(items, items[2]);
		assert.deepStrictEqual({
			checkbox: [checkbox.wasChecked, checkbox.checked, checkbox.items[0].checked],
			radio: [radio.wasChecked, radio.checked, radio.items.slice(1).map(item => item.checked)],
		}, {
			checkbox: [false, true, true],
			radio: [false, true, [false, true]],
		});
	});

	test('shows items for the right-clicked thing and groups several under the extension name', () => {
		const items = build(
			items => paradisCreateMenuItem(items, 'page', { title: 'Page item' }),
			items => paradisCreateMenuItem(items, 'link', { title: 'Open "%s"', contexts: ['link', 'selection'], targetUrlPatterns: ['https://*.example.com/*'] }),
			items => paradisCreateMenuItem(items, 'onlyHere', { title: 'Only &here && there', contexts: ['all'], documentUrlPatterns: ['https://site.test/*'] }),
			items => paradisCreateMenuItem(items, 'hidden', { title: 'Hidden', visible: false }),
			items => paradisCreateMenuItem(items, 'parent', { title: 'Parent', contexts: ['editable'] }),
			items => paradisCreateMenuItem(items, 'child', { title: 'Child', parentId: 'parent', contexts: ['page'] }),
		);
		const titles = (tree: ReturnType<typeof paradisVisibleMenuTree>) => tree.map(item => item.title);
		const onPage = paradisVisibleMenuTree(items, paradisMenuTargetFromParams({}, 'https://site.test/a', false), paradisMatchesUrlPattern);
		const onLink = paradisVisibleMenuTree(items, paradisMenuTargetFromParams({ linkURL: 'https://mail.example.com/x', selectionText: 'hello' }, 'https://other.test/', false), paradisMatchesUrlPattern);
		const onOtherLink = paradisVisibleMenuTree(items, paradisMenuTargetFromParams({ linkURL: 'https://evil.test/x' }, 'https://other.test/', false), paradisMatchesUrlPattern);
		const onInput = paradisVisibleMenuTree(items, paradisMenuTargetFromParams({ isEditable: true }, 'https://other.test/', true), paradisMatchesUrlPattern);
		assert.deepStrictEqual({
			onPage: titles(onPage),
			onLink: titles(onLink),
			onOtherLink: titles(onOtherLink),
			// 子がすべて外れた親（子は page だけ）は出さない
			onInput: titles(onInput),
			grouped: paradisArrangeExtensionMenu('Sample', onPage).map(item => [item.title, item.key, item.children.length]),
			single: paradisArrangeExtensionMenu('Sample', onLink).map(item => item.title),
			longSelection: paradisFormatMenuTitle('Search %s', 'x'.repeat(60)).length,
		}, {
			onPage: ['Page item', 'Only here & there'],
			onLink: ['Open "hello"'],
			onOtherLink: [],
			onInput: [],
			grouped: [['Sample', '', 2]],
			single: ['Open "hello"'],
			longSelection: 'Search '.length + 51,
		});
	});

	test('reports what was clicked the way chrome.contextMenus.OnClickData does', () => {
		const [item] = paradisCreateMenuItem([], 7, { title: 'Image', contexts: ['image'], parentId: undefined });
		const target = paradisMenuTargetFromParams({ srcURL: 'https://img.test/a.png', mediaType: 'image', frameURL: 'https://frame.test/' }, 'https://page.test/', true);
		assert.deepStrictEqual(paradisMenuClickData({ item, target, frameId: 12, editable: false, mediaType: 'image' }), {
			menuItemId: 7, mediaType: 'image', srcUrl: 'https://img.test/a.png', pageUrl: 'https://page.test/', frameUrl: 'https://frame.test/', frameId: 12, editable: false,
		});
	});

	test('drops broken stored rows and orphans', () => {
		assert.deepStrictEqual(paradisParseStoredMenuItems([
			{ id: 'a', type: 'normal', title: 'A', contexts: ['page'], visible: true, enabled: true },
			{ id: 'a', title: 'dup' },
			{ id: {}, title: 'bad id' },
			{ id: 'orphan', title: 'O', parentId: 'gone' },
			{ id: 'badType', type: 'button', title: 'B' },
		]).map(item => item.id), ['a']);
	});

	test('reads manifest commands for the platform, at most four suggested keys', () => {
		const manifest = {
			commands: {
				'_execute_action': { suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' } },
				'fill': { description: 'Fill the login', suggested_key: { default: 'Ctrl+Shift+L' } },
				'mac-control': { suggested_key: { mac: 'MacCtrl+Shift+K', default: 'Alt+K' } },
				'bad': { suggested_key: { default: 'Shift+B' } },
				'no-key': { description: 'Unassigned' },
				'fourth': { suggested_key: { default: 'Alt+Comma' } },
				'fifth': { suggested_key: { default: 'Alt+Period' } },
			},
		};
		const mac = paradisReadExtensionCommands(manifest, 'mac');
		const linux = paradisReadExtensionCommands(manifest, 'linux');
		assert.deepStrictEqual({
			mac: mac.map(command => [command.name, command.shortcut]),
			linux: linux.map(command => [command.name, command.shortcut]),
			fillBinding: linux[1].binding,
			macCtrlOnLinux: paradisParseShortcut('MacCtrl+K', 'linux'),
		}, {
			mac: [['_execute_action', '⇧⌘Y'], ['fill', '⇧⌘L'], ['mac-control', '⌃⇧K'], ['bad', ''], ['no-key', ''], ['fourth', '⌥Comma'], ['fifth', '']],
			linux: [['_execute_action', 'Ctrl+Shift+Y'], ['fill', 'Ctrl+Shift+L'], ['mac-control', 'Alt+K'], ['bad', ''], ['no-key', ''], ['fourth', 'Alt+Comma'], ['fifth', '']],
			fillBinding: { key: 'L', control: true, meta: false, alt: false, shift: true },
			macCtrlOnLinux: undefined,
		});
	});
});
