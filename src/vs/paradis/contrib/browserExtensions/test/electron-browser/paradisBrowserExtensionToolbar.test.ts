/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IParadisToolbarAction } from '../../common/paradisBrowserExtensions.js';
import { ParadisBrowserExtensionToolbarService, paradisShortcutMatchesKey } from '../../electron-browser/paradisBrowserExtensionToolbar.js';

suite('ParadisBrowserExtensionToolbar', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// Q639: 消した拡張機能のボタンのコマンドは、main の入っている拡張機能の一覧から消えたら外す
	test('drops the buttons of extensions that are no longer installed', async () => {
		let installed = ['a', 'b'];
		const onDidChangeToolbar = store.add(new Emitter<void>());
		const channel: IChannel = {
			call: async <T>(command: string) => (command === 'getInstalledIds' ? installed : command === 'getCommands' ? [] : undefined) as T,
			listen: <T>(event: string) => (event === 'onDidChangeToolbar' ? onDidChangeToolbar.event : Event.None) as Event<T>,
		};
		const service = store.add(new ParadisBrowserExtensionToolbarService(
			{ getChannel: () => channel } as Partial<IMainProcessService> as IMainProcessService,
			{ getValue: () => true } as Partial<IConfigurationService> as IConfigurationService,
			{ register: () => toDisposable(() => { }) } as Partial<IActionViewItemService> as IActionViewItemService,
		));
		const action = (extensionId: string, name: string): IParadisToolbarAction => ({ extensionId, name, title: name, badgeText: '', enabled: true, hasPopup: false, pinned: true, hasOptionsPage: false });
		service.ensureButtons([action('a', 'Alpha'), action('b', 'Beta')]);
		const registered = () => ['a', 'b'].filter(id => CommandsRegistry.getCommand(`paradis.browserExtensions.toolbarButton.${id}`) !== undefined);
		const before = registered();
		installed = ['a'];
		onDidChangeToolbar.fire();
		await timeout(300);
		assert.deepStrictEqual({ before, after: registered() }, { before: ['a', 'b'], after: ['a'] });
	});

	test('matches a key from the page against an extension shortcut', () => {
		const binding = (key: string, modifiers: { control?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }) => ({ key, control: false, meta: false, alt: false, shift: false, ...modifiers });
		const event = (key: string, code: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...modifiers });
		assert.deepStrictEqual([
			paradisShortcutMatchesKey(binding('L', { control: true, shift: true }), event('L', 'KeyL', { ctrlKey: true, shiftKey: true })),
			// Option で key が変わっても、押したキー（code）で比べる
			paradisShortcutMatchesKey(binding('L', { alt: true }), event('¬', 'KeyL', { altKey: true })),
			paradisShortcutMatchesKey(binding('5', { control: true }), event('5', 'Digit5', { ctrlKey: true })),
			// 修飾キーが 1 つでも違えば別
			paradisShortcutMatchesKey(binding('L', { control: true, shift: true }), event('L', 'KeyL', { ctrlKey: true })),
			paradisShortcutMatchesKey(binding('L', { meta: true }), event('l', 'KeyL', { ctrlKey: true })),
			paradisShortcutMatchesKey(binding('Comma', { alt: true }), event(',', 'Comma', { altKey: true })),
			paradisShortcutMatchesKey(binding('Up', { alt: true }), event('ArrowUp', 'ArrowUp', { altKey: true })),
		], [true, true, true, false, false, true, true]);
	});
});
