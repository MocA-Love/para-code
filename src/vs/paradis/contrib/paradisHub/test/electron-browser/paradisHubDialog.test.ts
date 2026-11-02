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
import { IParadisHubAreaContainers, IParadisHubAreaView, IParadisHubHost, ParadisHubAreaId, paradisRegisterHubArea } from '../../electron-browser/paradisHub.js';
import { ParadisHubDialog } from '../../electron-browser/paradisHubDialog.js';
import { paradisHubNavItem } from '../../electron-browser/paradisHubNav.js';

/** 呼ばれたことを記録するだけの領域。 */
class TestArea implements IParadisHubAreaView {
	readonly calls: string[] = [];
	disposed = false;

	constructor(readonly id: string, containers: IParadisHubAreaContainers, readonly host: IParadisHubHost, private readonly consumeEscape: boolean) {
		paradisHubNavItem(containers.nav, `${id} nav`);
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
		const dialog = store.add(instantiationService.createInstance(ParadisHubDialog, area, section));
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
				body: ['settings navsettings content'],
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
});
