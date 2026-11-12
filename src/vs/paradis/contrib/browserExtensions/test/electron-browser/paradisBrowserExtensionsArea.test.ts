/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Event } from '../../../../../base/common/event.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ResultKind } from '../../../../../platform/keybinding/common/keybindingResolver.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { INativeHostService } from '../../../../../platform/native/common/native.js';
import { IParadisAgentBrowserBindingModel } from '../../../agentBrowser/electron-browser/paradisAgentBrowserBindingModel.js';
import { IParadisBrowserProfilesService } from '../../../browserProfiles/electron-browser/paradisBrowserProfilesService.js';
import { IParadisHubHost } from '../../../paradisHub/electron-browser/paradisHub.js';
import { IParadisBrowserExtensionView, PARADIS_DEFAULT_EXTENSION_PROFILE } from '../../common/paradisBrowserExtensions.js';
import { ParadisBrowserExtensionsArea } from '../../electron-browser/paradisBrowserExtensionsArea.js';

function extension(id: string, name: string): IParadisBrowserExtensionView {
	return { id, name, version: '1.0.0', manifestVersion: 3, source: 'webstore', sourcePath: '', path: `/x/${id}`, installedAt: 0, touchesPages: false, enabledIn: [PARADIS_DEFAULT_EXTENSION_PROFILE], allowedOnRemote: false };
}

suite('ParadisBrowserExtensionsArea', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createArea(extensions: IParadisBrowserExtensionView[], calls: unknown[][] = [], options: { readonly active?: boolean; readonly updateValue?: () => Promise<void> } = {}) {
		const doc = mainWindow.document;
		const containers = { nav: doc.body.appendChild(doc.createElement('nav')), content: doc.body.appendChild(doc.createElement('div')), header: doc.createElement('div') };
		store.add({ dispose: () => { containers.nav.remove(); containers.content.remove(); } });
		const state = { active: options.active ?? true, setting: options.active ?? true, extensions };
		const channel: IChannel = {
			call: async <T>(command: string, arg?: unknown) => {
				calls.push([command, ...(Array.isArray(arg) ? arg : [])]);
				return (command === 'getState' ? state : command === 'getWorkerLog' ? [] : command === 'assignShortcut' ? true : undefined) as T;
			},
			listen: <T>() => Event.None as Event<T>,
		};
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(IMainProcessService, { getChannel: () => channel } as Partial<IMainProcessService>);
		instantiationService.stub(IParadisBrowserProfilesService, { list: () => [], onDidChangeProfiles: Event.None } as Partial<IParadisBrowserProfilesService>);
		instantiationService.stub(IFileDialogService, {});
		instantiationService.stub(IConfigurationService, { getValue: () => undefined, updateValue: options.updateValue ?? (async () => { }) } as Partial<IConfigurationService>);
		instantiationService.stub(INativeHostService, {});
		instantiationService.stub(IParadisAgentBrowserBindingModel, { bindings: [] } as Partial<IParadisAgentBrowserBindingModel>);
		instantiationService.stub(IContextViewService, {});
		instantiationService.stub(IHoverService, NullHoverService);
		// Ctrl+Shift+P だけを Para Code のキー（コマンドパレット）とみなす
		instantiationService.stub(IKeybindingService, {
			softDispatch: (event: { ctrlKey: boolean; shiftKey: boolean; browserEvent: KeyboardEvent }) => event.ctrlKey && event.shiftKey && event.browserEvent.code === 'KeyP'
				? { kind: ResultKind.KbFound, commandId: 'workbench.action.showCommands', commandArgs: undefined, isBubble: false }
				: { kind: ResultKind.NoMatchingKb },
		} as unknown as Partial<IKeybindingService>);
		instantiationService.stub(IEditorService, { visibleEditorPanes: [] } as Partial<IEditorService>);
		const host: IParadisHubHost = { close: () => { }, open: () => { } };
		const area = store.add(instantiationService.createInstance(ParadisBrowserExtensionsArea, containers, host));
		return Object.assign(containers, { area });
	}

	// Q544: 背景の処理がある拡張機能は、設定と権限を左の列、ログを右の列に置く。無いものは 1 列のまま
	test('puts the service worker log in a right column only for extensions that have one', async () => {
		const containers = createArea([{ ...extension('a', 'Alpha'), worker: { running: false } }, extension('b', 'Beta')]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const layout = () => {
			const detail = containers.content.querySelector<HTMLElement>('.pbe-detail')!;
			return {
				twoColumns: detail.classList.contains('pbe-detail-2col'),
				children: [...detail.children].map(child => child.className),
				log: [...detail.querySelectorAll('.pbe-log')].map(log => log.closest('.pbe-col-log') !== null),
			};
		};
		const steps = [layout()];
		containers.nav.querySelectorAll<HTMLElement>('.pbe-list-row')[1].click();
		steps.push(layout());
		assert.deepStrictEqual(steps, [
			{ twoColumns: true, children: ['pbe-col-main', 'pbe-col-log'], log: [true] },
			{ twoColumns: false, children: ['pbe-detail-header', 'pbe-detail-actions', 'pbe-confirm-host', 'pbe-callout is-error', 'pbe-section', 'pbe-section', 'pbe-section'], log: [] },
		]);
	});

	// 一覧は選んでいる行だけが Tab で止まるので、上下の矢印・Home・End で隣の行へ移って選べること
	test('moves the selection through the installed list with the arrow keys, Home and End', async () => {
		const doc = mainWindow.document;
		const containers = createArea([extension('a', 'Alpha'), extension('b', 'Beta'), extension('c', 'Gamma')]);
		await new Promise(resolve => setTimeout(resolve, 0));

		const selected = () => {
			const rows = [...containers.nav.querySelectorAll<HTMLElement>('.pbe-list-row')];
			const row = rows.find(candidate => candidate.getAttribute('aria-selected') === 'true');
			return `${row?.querySelector('.pbpm-name')?.textContent}:${row === doc.activeElement}:${rows.map(candidate => candidate.tabIndex).join(',')}`;
		};
		const press = (key: string) => doc.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
		containers.nav.querySelector<HTMLElement>('.pbe-list-row')!.focus();
		const steps = [selected()];
		for (const key of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
			press(key);
			steps.push(`${key} ${selected()}`);
		}
		assert.deepStrictEqual(steps, [
			'Alpha:true:0,-1,-1',
			'ArrowDown Beta:true:-1,0,-1',
			'ArrowDown Gamma:true:-1,-1,0',
			'ArrowDown Gamma:true:-1,-1,0',
			'ArrowUp Beta:true:-1,0,-1',
			'Home Alpha:true:0,-1,-1',
			'End Gamma:true:-1,-1,0',
		]);
	});

	// Q619: 「設定」の「ショートカット」の一覧。重なりは左の行にも出し、Para Code のキーは断り、ほかの拡張機能のキーは付け替えるか確かめる
	// キーの見せ方は OS で違う（macOS は ⌃⇧L）ので、Ctrl で書く OS で確かめる
	(isMacintosh ? test.skip : test)('lists the shortcuts, refuses Para Code keys and asks before taking a key from another extension', async () => {
		const doc = mainWindow.document;
		const calls: unknown[][] = [];
		const containers = createArea([
			{ ...extension('a', 'Alpha'), installedAt: 1, commands: [{ name: 'fill', description: 'Fill', shortcut: 'Ctrl+Shift+L', suggested: 'Ctrl+Shift+L', source: 'suggested' }] },
			{ ...extension('b', 'Beta'), installedAt: 2, commands: [{ name: 'autofill', description: 'Autofill', shortcut: '', suggested: 'Ctrl+Shift+L', source: 'lost', lostTo: { extensionId: 'a', name: 'fill' } }, { name: 'lock', description: 'Lock', shortcut: '', suggested: '', source: 'none' }] },
		], calls);
		await new Promise(resolve => setTimeout(resolve, 0));
		const rowStatus = [...containers.nav.querySelectorAll('.pbe-list-row .pbpm-meta')].map(meta => meta.textContent);
		[...containers.nav.querySelectorAll<HTMLElement>('.phub-nav-item')].find(item => item.textContent === 'ショートカット')!.click();
		const page = () => [...containers.content.querySelectorAll('.pbe-sc-row')].map(row => [row.querySelector('.pbe-sc-desc')?.textContent, row.querySelector('.pbe-sc-keys')?.getAttribute('aria-label') ?? row.querySelector('.pbe-sc-unset, .pbe-sc-recorder')?.textContent, row.querySelector('.pbe-sc-warn')?.textContent ?? '']);
		const listed = page();
		const message = () => containers.content.querySelector('.pbe-message')?.textContent;
		const press = (code: string, modifiers: KeyboardEventInit) => doc.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.replace(/^Key/, ''), bubbles: true, cancelable: true, ...modifiers }));
		// Beta の lock の「キーを付ける」
		containers.content.querySelectorAll<HTMLElement>('.pbe-sc-row .paradis-button:not(.paradis-button-icon)')[2].click();
		const recording = page()[2];
		press('KeyL', { shiftKey: true });
		const noModifier = message();
		press('KeyP', { ctrlKey: true, shiftKey: true });
		const paraCode = message();
		press('KeyL', { ctrlKey: true, shiftKey: true });
		const conflict = containers.content.querySelector('.pbe-sc-conflict span:not(.codicon)')?.textContent;
		containers.content.querySelector<HTMLElement>('.pbe-sc-conflict .paradis-button-primary')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({
			rowStatus,
			listed,
			recording,
			noModifier,
			paraCode,
			conflict,
			assigned: calls.filter(call => call[0] === 'assignShortcut'),
		}, {
			rowStatus: ['バージョン 1.0.0', 'キーの重なり 1'],
			listed: [['Fill', 'Ctrl+Shift+L', ''], ['Autofill', '未設定', 'Ctrl+Shift+L は Alpha が使っています'], ['Lock', '未設定', '']],
			recording: ['Lock', 'キーを押してください（Esc でやめる）', ''],
			noModifier: 'Ctrl・Alt のどちらかと一緒に押してください（Chrome と同じく、Shift だけではショートカットになりません）。',
			paraCode: 'Ctrl+Shift+P は Para Code の「workbench.action.showCommands」に使われています。ページの中では Para Code が先に取るので、拡張機能には付けられません。',
			conflict: 'Ctrl+Shift+L は Alpha の「Fill」が使っています。付け替えると、Alpha のほうは外れます。',
			assigned: [['assignShortcut', 'b', 'lock', { key: 'L', control: true, meta: false, alt: false, shift: true }]],
		});
	});

	// スイッチやボタンを押すと画面を作り直すので、終わった後に押した操作へフォーカスを戻すこと（キーボードで位置を見失わない）
	test('keeps the keyboard focus on the switch that was toggled', async () => {
		const doc = mainWindow.document;
		const containers = createArea([extension('a', 'Alpha')]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const remoteSwitch = () => [...containers.content.querySelectorAll<HTMLElement>('label.pbe-row-option')].find(label => label.textContent === 'SSH 先のページでも使う')?.querySelector<HTMLButtonElement>('.paradis-switch');
		remoteSwitch()!.focus();
		remoteSwitch()!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(doc.activeElement !== null && doc.activeElement === remoteSwitch(), true);
	});

	// 削除の確認を出しているときの Esc は確認だけを閉じ（モーダルは閉じない）、「削除」へフォーカスを戻すこと
	test('closes only the remove confirmation on Escape and gives the focus back to the remove button', async () => {
		const doc = mainWindow.document;
		const containers = createArea([extension('a', 'Alpha')]);
		await new Promise(resolve => setTimeout(resolve, 0));
		const remove = () => [...containers.content.querySelectorAll<HTMLElement>('.pbe-detail-actions .paradis-button')].find(button => button.textContent === '削除');
		remove()!.click();
		const shown = containers.content.querySelector('.pbpm-confirm') !== null;
		const handled = containers.area.handleEscape();
		assert.deepStrictEqual({
			shown,
			handled,
			confirmAfter: containers.content.querySelector('.pbpm-confirm') !== null,
			focusedRemove: doc.activeElement !== null && doc.activeElement === remove(),
			nextEscapeClosesModal: !containers.area.handleEscape(),
		}, { shown: true, handled: true, confirmAfter: false, focusedRemove: true, nextEscapeClosesModal: true });
	});

	// 「オンにする」で設定を書けなかったら、その理由を出すこと（押しても何も起きないように見せない）
	test('tells why turning the feature on failed', async () => {
		const containers = createArea([], [], { active: false, updateValue: async () => { throw new Error('settings.json is broken'); } });
		await new Promise(resolve => setTimeout(resolve, 0));
		containers.content.querySelector<HTMLElement>('.pbe-notice .paradis-button')!.click();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual({ text: containers.content.querySelector('.pbe-message')?.textContent, error: containers.content.querySelector('.pbe-message')?.classList.contains('is-error') }, {
			text: '設定を書き換えられませんでした（settings.json is broken）。',
			error: true,
		});
	});
});
