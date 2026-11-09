/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { dispose, IDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisHubAreaContainers, IParadisHubAreaView, IParadisHubAreaViewState, IParadisHubHost, ParadisHubAreaId, paradisRegisterHubArea } from '../../electron-browser/paradisHub.js';
import { ParadisHubDialog } from '../../electron-browser/paradisHubDialog.js';
import { paradisOpenHub } from '../../electron-browser/paradisHubOpen.js';
import { paradisHubNavItem } from '../../electron-browser/paradisHubNav.js';

/** 呼ばれたことを記録するだけの領域。 */
class TestArea implements IParadisHubAreaView {
	readonly calls: string[] = [];
	disposed = false;

	constructor(readonly id: string, containers: IParadisHubAreaContainers, readonly host: IParadisHubHost, private readonly consumeEscape: boolean) {
		paradisHubNavItem(containers.nav, `${id} nav`).setActive(true);
		paradisHubNavItem(containers.nav, `${id} nav 2`);
		paradisHubNavItem(containers.nav, `${id} nav 3`);
		containers.content.textContent = `${id} content`;
		containers.header.textContent = `${id} header`;
	}

	reveal(section: string | undefined): void {
		this.calls.push(`reveal:${section ?? ''}`);
	}

	setVisible(visible: boolean): void {
		this.calls.push(`visible:${visible}`);
	}

	layout(): void { }

	saveViewState(): IParadisHubAreaViewState {
		return { section: `saved-${this.id}`, scrollTop: 40 };
	}

	restoreViewState(state: IParadisHubAreaViewState): void {
		this.calls.push(`restore:${state.section}:${state.scrollTop}`);
	}

	handleEscape(): boolean {
		this.calls.push('escape');
		return this.consumeEscape;
	}

	dispose(): void {
		this.disposed = true;
	}
}

suite('ParadisHubDialog', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const created = new Map<string, TestArea>();

	// テストの領域は実物の ID を借りて登録し、終わったら前の登録に戻す（器は登録された全領域を上段に並べる）
	let registrations: IDisposable[] = [];
	suiteSetup(() => {
		registrations = [
			paradisRegisterHubArea({ id: ParadisHubAreaId.Usage, label: 'Usage', order: 10, create: (_, containers, host) => { const area = new TestArea('usage', containers, host, false); created.set('usage', area); return area; } }),
			paradisRegisterHubArea({ id: ParadisHubAreaId.Settings, label: 'Settings', order: 20, create: (_, containers, host) => { const area = new TestArea('settings', containers, host, true); created.set('settings', area); return area; } }),
		];
	});
	suiteTeardown(() => dispose(registrations));

	function open(area: ParadisHubAreaId, section?: string): { dialog: ParadisHubDialog; container: HTMLElement } {
		created.clear();
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => container.remove()));
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ILayoutService, { activeContainer: container } as Partial<ILayoutService>);
		instantiationService.stub(ILogService, new NullLogService());
		const dialog = store.add(instantiationService.createInstance(ParadisHubDialog, area, section, undefined));
		return { dialog, container };
	}

	function visibleText(container: HTMLElement, selector: string): string[] {
		return [...container.querySelectorAll<HTMLElement>(selector)].filter(element => element.style.display !== 'none').map(element => element.textContent ?? '');
	}

	test('creates only the opened area, then switches areas from the top switch without recreating them', () => {
		const { dialog, container } = open(ParadisHubAreaId.Settings, 'psd-sec-agent');
		const first = {
			created: [...created.keys()],
			buttons: [...container.querySelectorAll('.phub-areas button')].map(button => `${button.textContent}:${button.classList.contains('checked')}`),
			body: visibleText(container, '.phub-body'),
			header: visibleText(container, '.phub-header-slot'),
			settings: [...created.get('settings')!.calls],
		};
		container.querySelector<HTMLButtonElement>('.phub-areas button')!.click();
		dialog.open(ParadisHubAreaId.Settings);
		assert.deepStrictEqual({
			first,
			created: [...created.keys()],
			usage: created.get('usage')!.calls,
			settings: created.get('settings')!.calls,
		}, {
			first: {
				created: ['settings'],
				buttons: ['Usage:false', 'Settings:true'],
				body: ['settings navsettings nav 2settings nav 3settings content'],
				header: ['settings header'],
				settings: ['visible:true', 'reveal:psd-sec-agent'],
			},
			created: ['settings', 'usage'],
			usage: ['visible:true', 'reveal:', 'visible:false'],
			settings: ['visible:true', 'reveal:psd-sec-agent', 'visible:false', 'visible:true', 'reveal:'],
		});
	});

	test('closes on Escape unless the open area uses it, and disposes the areas with the dialog', () => {
		const { dialog, container } = open(ParadisHubAreaId.Settings);
		const escape = () => mainWindow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
		escape();
		const keptBySettings = container.contains(container.querySelector('.paradis-hub'));
		dialog.open(ParadisHubAreaId.Usage);
		const usage = created.get('usage')!;
		const settings = created.get('settings')!;
		escape();
		assert.deepStrictEqual({
			keptBySettings,
			closed: !container.querySelector('.paradis-hub'),
			disposed: [usage.disposed, settings.disposed],
		}, { keptBySettings: true, closed: true, disposed: [true, true] });
	});

	test('follows the tab pattern on the area switch and moves through the left nav with the arrow keys', () => {
		const { container } = open(ParadisHubAreaId.Usage);
		const key = (target: HTMLElement, code: string, keyCode: number) => target.dispatchEvent(new KeyboardEvent('keydown', { key: code, code, keyCode, bubbles: true }));
		const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('.phub-areas button')];
		const describeTabs = () => tabs().map(tab => {
			const panel = container.querySelector<HTMLElement>(`#${tab.getAttribute('aria-controls')}`);
			return `${tab.textContent}:${tab.getAttribute('aria-selected')}:${tab.tabIndex}:${panel?.getAttribute('role')}:${panel?.getAttribute('aria-labelledby') === tab.id}`;
		});
		const before = describeTabs();
		tabs()[0].focus();
		key(tabs()[0], 'ArrowRight', 39);
		const afterRight = { tabs: describeTabs(), focused: mainWindow.document.activeElement?.textContent };
		key(tabs()[1], 'Home', 36);
		const afterHome = describeTabs();

		const nav = container.querySelector<HTMLElement>('.phub-body:not([style*="none"]) .phub-nav')!;
		const items = [...nav.querySelectorAll<HTMLElement>('.phub-nav-item')];
		items[0].focus();
		key(items[0], 'ArrowDown', 40);
		const down = { focused: mainWindow.document.activeElement?.textContent, tabIndexes: items.map(item => item.tabIndex) };
		key(items[1], 'End', 35);
		const end = mainWindow.document.activeElement?.textContent;
		assert.deepStrictEqual({ before, afterRight, afterHome, down, end }, {
			before: ['Usage:true:0:tabpanel:true', 'Settings:false:-1:tabpanel:true'],
			afterRight: { tabs: ['Usage:false:-1:tabpanel:true', 'Settings:true:0:tabpanel:true'], focused: 'Settings' },
			afterHome: ['Usage:true:0:tabpanel:true', 'Settings:false:-1:tabpanel:true'],
			down: { focused: 'usage nav 2', tabIndexes: [-1, 0, -1] },
			end: 'usage nav 3',
		});
	});

	// エディタのタブを開くボタンで閉じた後に開き直すと、同じ領域なら閉じたときの節とスクロール位置へ戻る
	test('reopens the same area at the section and scroll position it was closed at, unless another area or a section is asked for', () => {
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => container.remove()));
		const instantiationService = store.add(new TestInstantiationService());
		instantiationService.stub(ILayoutService, { activeContainer: container } as Partial<ILayoutService>);
		instantiationService.stub(ILogService, new NullLogService());
		// 幕には fork のモーダルの段の印が付く（本家のメニュー・確認・通知が器の上に出る段。paradisModal.ts の表）
		const marked: boolean[] = [];
		const openAndClose = (area: ParadisHubAreaId, section?: string) => {
			created.clear();
			instantiationService.invokeFunction(accessor => paradisOpenHub(accessor, area, section));
			marked.push(container.querySelector('.paradis-hub-backdrop')?.classList.contains('paradis-modal-backdrop') ?? false);
			const calls = [...created.values()].map(view => [...view.calls]);
			container.querySelector<HTMLButtonElement>('.phub-close')!.click();
			return calls;
		};
		assert.deepStrictEqual([
			openAndClose(ParadisHubAreaId.Settings, 'psd-sec-agent'),
			openAndClose(ParadisHubAreaId.Settings),
			openAndClose(ParadisHubAreaId.Settings, 'psd-sec-menubar'),
			openAndClose(ParadisHubAreaId.Usage),
			openAndClose(ParadisHubAreaId.Usage),
			{ open: marked, afterClose: container.querySelectorAll('.paradis-modal-backdrop').length, dialogs: container.querySelectorAll('.paradis-hub').length },
		], [
			[['visible:true', 'reveal:psd-sec-agent']],
			[['visible:true', 'reveal:saved-settings', 'restore:saved-settings:40']],
			[['visible:true', 'reveal:psd-sec-menubar']],
			[['visible:true', 'reveal:']],
			[['visible:true', 'reveal:saved-usage', 'restore:saved-usage:40']],
			{ open: [true, true, true, true, true], afterClose: 0, dialogs: 0 },
		]);
	});

	test('does not open an area that is not registered', () => {
		const { dialog, container } = open(ParadisHubAreaId.Usage);
		dialog.open(ParadisHubAreaId.Changelog);
		const shown = container.querySelectorAll('.phub-areas button.checked').length;
		const instantiationService = store.add(new TestInstantiationService());
		const other = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		store.add(toDisposable(() => other.remove()));
		instantiationService.stub(ILayoutService, { activeContainer: other } as Partial<ILayoutService>);
		instantiationService.stub(ILogService, new NullLogService());
		instantiationService.invokeFunction(accessor => paradisOpenHub(accessor, ParadisHubAreaId.Changelog));
		assert.deepStrictEqual({ selected: [...container.querySelectorAll('.phub-areas button.checked')].map(button => button.textContent), shown, openedElsewhere: other.querySelectorAll('.paradis-hub').length }, { selected: ['Usage'], shown: 1, openedElsewhere: 0 });
	});
});
