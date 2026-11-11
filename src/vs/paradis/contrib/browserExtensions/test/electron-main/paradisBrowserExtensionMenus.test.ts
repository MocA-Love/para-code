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
	paradisResolveExtensionShortcuts,
	paradisShortcutFromKeyEvent,
	paradisShortcutToSuggestedKey,
	paradisWithAssignedShortcut,
	paradisWithoutUserShortcut,
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

	// Q619: 利用者が決めたキーを先に、おすすめのキーを先に入れた順に入れる
	test('assigns the keys the person chose first, then suggested keys in install order', () => {
		const first = { id: 'first', manifest: { commands: { open: { suggested_key: { default: 'Ctrl+Shift+X' } }, fill: { description: 'Fill', suggested_key: { default: 'Ctrl+Shift+L' } } } } };
		const second = { id: 'second', manifest: { commands: { autofill: { suggested_key: { default: 'Ctrl+Shift+L' } }, lock: { suggested_key: { default: 'Ctrl+Shift+K' } }, generate: {} } } };
		const shape = (shortcuts: Parameters<typeof paradisResolveExtensionShortcuts>[2]) => [...paradisResolveExtensionShortcuts([first, second], 'linux', shortcuts)].map(([id, commands]) => [id, commands.map(command => [command.name, command.shortcut, command.source, command.lostTo?.name ?? ''])]);
		assert.deepStrictEqual({
			// 前の版の台帳（利用者のキーが無い）: 先に入れた方が取る（#912 のまま）
			none: shape(undefined),
			// 後から入れた側が Ctrl+Shift+L を利用者のキーにした: 先に入れた方のおすすめのキーは外れる
			userFirst: shape({ second: { autofill: 'Ctrl+Shift+L', lock: '' } }),
			// 読めない値は無いのと同じ。同じキーを 2 つに付けていたら、先の 1 つだけ
			broken: shape({ first: { open: 'Shift+X' }, second: { autofill: 'Ctrl+Shift+U', generate: 'Ctrl+Shift+U' } }),
		}, {
			none: [['first', [['open', 'Ctrl+Shift+X', 'suggested', ''], ['fill', 'Ctrl+Shift+L', 'suggested', '']]], ['second', [['autofill', '', 'lost', 'fill'], ['lock', 'Ctrl+Shift+K', 'suggested', ''], ['generate', '', 'none', '']]]],
			userFirst: [['first', [['open', 'Ctrl+Shift+X', 'suggested', ''], ['fill', '', 'lost', 'autofill']]], ['second', [['autofill', 'Ctrl+Shift+L', 'user', ''], ['lock', '', 'removed', ''], ['generate', '', 'none', '']]]],
			broken: [['first', [['open', 'Ctrl+Shift+X', 'suggested', ''], ['fill', 'Ctrl+Shift+L', 'suggested', '']]], ['second', [['autofill', 'Ctrl+Shift+U', 'user', ''], ['lock', 'Ctrl+Shift+K', 'suggested', ''], ['generate', '', 'removed', '']]]],
		});
	});

	test('takes a key over from the command that uses it, and clears or resets a key', () => {
		const first = { id: 'first', manifest: { commands: { fill: { suggested_key: { default: 'Ctrl+Shift+L' } }, open: { suggested_key: { default: 'Ctrl+Shift+X' } } } } };
		const second = { id: 'second', manifest: { commands: { autofill: { suggested_key: { default: 'Ctrl+Shift+L' } }, lock: {} } } };
		const L = { key: 'L', control: true, meta: false, alt: false, shift: true };
		const X = { key: 'X', control: true, meta: false, alt: false, shift: true };
		const taken = paradisWithAssignedShortcut({}, [first, second], 'linux', 'second', 'autofill', L)!;
		// lock に X を付けると、X を使っていた first.open が外れる
		const again = paradisWithAssignedShortcut(taken, [first, second], 'linux', 'second', 'lock', X)!;
		const keys = (shortcuts: Parameters<typeof paradisResolveExtensionShortcuts>[2]) => [...paradisResolveExtensionShortcuts([first, second], 'linux', shortcuts).values()].flat().map(command => `${command.name}=${command.shortcut}`);
		assert.deepStrictEqual({
			taken,
			takenKeys: keys(taken),
			again,
			// ✕ で外す・↺ でおすすめのキーに戻す（外れた first.fill は外れたままなので、autofill はおすすめの L に戻る）
			cleared: paradisWithoutUserShortcut(again, 'second', 'lock', 'clear'),
			reset: paradisWithoutUserShortcut(taken, 'second', 'autofill', 'reset'),
			resetKeys: keys(paradisWithoutUserShortcut(taken, 'second', 'autofill', 'reset')),
			unknownCommand: paradisWithAssignedShortcut({}, [first, second], 'linux', 'second', 'missing', L),
			noModifier: paradisWithAssignedShortcut({}, [first, second], 'linux', 'second', 'lock', { ...L, control: false }),
			metaOnLinux: paradisShortcutToSuggestedKey({ ...L, meta: true }, 'linux'),
			mac: paradisShortcutToSuggestedKey({ key: 'L', control: true, meta: true, alt: true, shift: true }, 'mac'),
		}, {
			taken: { first: { fill: '' }, second: { autofill: 'Ctrl+Shift+L' } },
			takenKeys: ['fill=', 'open=Ctrl+Shift+X', 'autofill=Ctrl+Shift+L', 'lock='],
			again: { first: { fill: '', open: '' }, second: { autofill: 'Ctrl+Shift+L', lock: 'Ctrl+Shift+X' } },
			cleared: { first: { fill: '', open: '' }, second: { autofill: 'Ctrl+Shift+L', lock: '' } },
			reset: { first: { fill: '' } },
			resetKeys: ['fill=', 'open=Ctrl+Shift+X', 'autofill=Ctrl+Shift+L', 'lock='],
			unknownCommand: undefined,
			noModifier: undefined,
			metaOnLinux: undefined,
			mac: 'MacCtrl+Alt+Shift+Command+L',
		});
	});

	test('reads the key pressed to set a shortcut and refuses keys without a modifier or used by Para Code', () => {
		const press = (code: string, key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }, paraCode?: string) =>
			paradisShortcutFromKeyEvent({ code, key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers }, modifiers.metaKey ? 'mac' : 'linux', () => paraCode);
		assert.deepStrictEqual({
			ok: press('KeyL', 'L', { ctrlKey: true, shiftKey: true }),
			// Option で key が変わっても、押した位置で読む
			macOption: press('KeyK', '˚', { metaKey: true, altKey: true }),
			arrow: press('ArrowUp', 'ArrowUp', { altKey: true }),
			modifierOnly: press('ShiftLeft', 'Shift', { shiftKey: true }),
			shiftOnly: press('KeyL', 'L', { shiftKey: true }),
			unsupported: press('F5', 'F5', { ctrlKey: true }),
			metaOnLinux: paradisShortcutFromKeyEvent({ code: 'KeyL', key: 'l', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false }, 'linux', () => undefined),
			paraCode: press('KeyP', 'P', { ctrlKey: true, shiftKey: true }, 'Show All Commands'),
		}, {
			ok: { binding: { key: 'L', control: true, meta: false, alt: false, shift: true }, shortcut: 'Ctrl+Shift+L' },
			macOption: { binding: { key: 'K', control: false, meta: true, alt: true, shift: false }, shortcut: '⌥⌘K' },
			arrow: { binding: { key: 'Up', control: false, meta: false, alt: true, shift: false }, shortcut: 'Alt+Up' },
			modifierOnly: { refusal: 'modifierOnly' },
			shiftOnly: { refusal: 'noModifier' },
			unsupported: { refusal: 'unsupportedKey' },
			metaOnLinux: { refusal: 'metaKey' },
			paraCode: { refusal: 'paraCode', shortcut: 'Ctrl+Shift+P', command: 'Show All Commands' },
		});
	});
});
