/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// シミュレータのタブの見出しの「ペインに渡す」ボタン（q.html Q688 の案 B）。内蔵ブラウザの共有のボタンと同じく、
// 本体は共有ダイアログ、▾ は渡しているペインの一覧と「渡すのをやめる」。

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ITerminalService } from '../../../../../workbench/contrib/terminal/browser/terminal.js';
import { IParadisPaneTokenService } from '../../../agentBrowser/browser/paradisPaneTokenService.js';
import { IParadisMobileAttachment, IParadisMobileCanvasSnapshot, IParadisMobileDevice } from '../../common/paradisMobileCanvas.js';
import { IParadisMobileCanvasModel } from '../../electron-browser/paradisMobileCanvasModel.js';
import { PARADIS_MOBILE_OPEN_ATTACH_DIALOG_COMMAND_ID, ParadisSimulatorShareButton, paradisSimulatorShareEntries } from '../../electron-browser/paradisSimulatorShareButton.js';

const IPHONE = 'ios:core-simulator:A1B2C3D4-0000-1111-2222-333344445555';

function attachment(paneToken: string, deviceId: string, current?: boolean): IParadisMobileAttachment {
	return { paneToken, deviceId, deviceName: 'iPhone 17', stateKey: undefined, attachedAt: 0, ...(current ? { current } : {}) };
}

class FakeModel implements Partial<IParadisMobileCanvasModel> {
	readonly onDidChangeEmitter = new Emitter<void>();
	readonly onDidChange = this.onDidChangeEmitter.event;
	snapshot: IParadisMobileCanvasSnapshot = { devices: [], attachments: [] };
	readonly detached: string[] = [];
	async detach(paneToken: string, deviceId?: string): Promise<void> {
		this.detached.push(`${paneToken} ${deviceId}`);
		this.snapshot = { ...this.snapshot, attachments: this.snapshot.attachments.filter(entry => !(entry.paneToken === paneToken && entry.deviceId === deviceId)) };
		this.onDidChangeEmitter.fire();
	}
}

suite('Paradis simulator: the "give to a pane" button in the tab header', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let container: HTMLElement;

	setup(() => {
		container = mainWindow.document.createElement('div');
		container.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(container);
	});

	teardown(() => container.remove());

	function create(model: FakeModel) {
		const commands: unknown[][] = [];
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IParadisMobileCanvasModel, model as unknown as IParadisMobileCanvasModel);
		instantiation.stub(ICommandService, { executeCommand: async (...args: unknown[]) => { commands.push(args); return undefined; } } as unknown as ICommandService);
		instantiation.stub(IHoverService, NullHoverService);
		instantiation.stub(ILayoutService, { getContainer: () => container } as unknown as ILayoutService);
		instantiation.stub(IParadisPaneTokenService, { getInstanceForToken: (token: string) => token === 'pane-a' ? 1 : token === 'pane-b' ? 2 : undefined, onDidChange: Event.None } as unknown as IParadisPaneTokenService);
		instantiation.stub(ITerminalService, { getInstanceFromId: (id: number) => ({ title: id === 1 ? 'Paracode-SSH' : 'para-code-37' }), onAnyInstanceTitleChange: Event.None } as unknown as ITerminalService);
		const button = store.add(instantiation.createInstance(ParadisSimulatorShareButton, container));
		return { button, commands };
	}

	function state(button: ParadisSimulatorShareButton) {
		const main = button.element.querySelector<HTMLElement>('.paradis-simulator-share-main')!;
		const list = button.element.querySelector<HTMLElement>('.paradis-simulator-share-list')!;
		return {
			hidden: button.element.hidden,
			checked: button.element.classList.contains('checked'),
			badge: main.querySelector('.paradis-count')?.textContent ?? '',
			label: main.getAttribute('aria-label'),
			listHidden: list.hidden,
		};
	}

	// 起動して id が替わった Android も同じ端末とみなす（台帳の古い id で渡したペインも数える）
	test('counts the panes that hold this device, also under the id it had before it booted', () => {
		const devices = [{ id: 'android:serial:emulator-5554', avdId: 'android:avd:Pixel', name: 'Pixel', platform: 'android', state: 'device' }] as unknown as IParadisMobileDevice[];
		const attachments = [attachment('pane-a', 'android:avd:Pixel'), attachment('pane-b', 'android:serial:emulator-5554'), attachment('pane-c', IPHONE)];
		assert.deepStrictEqual([
			paradisSimulatorShareEntries('android:serial:emulator-5554', attachments, devices).map(entry => entry.paneToken),
			paradisSimulatorShareEntries(IPHONE, attachments, devices).map(entry => entry.paneToken),
			paradisSimulatorShareEntries(undefined, attachments, devices).length,
		], [['pane-a', 'pane-b'], ['pane-c'], 0]);
	});

	test('shows the count, opens the dialog on this device, and lists the panes with a way to stop giving the device', async () => {
		const model = store.add(new class extends FakeModel implements IDisposable { dispose() { this.onDidChangeEmitter.dispose(); } }());
		const { button, commands } = create(model);
		const beforeDevice = state(button);
		button.setDevice(IPHONE);
		const unshared = state(button);
		button.element.querySelector<HTMLElement>('.paradis-simulator-share-main')!.click();

		model.snapshot = { devices: [], attachments: [attachment('pane-a', IPHONE, true), attachment('pane-b', IPHONE), attachment('pane-b', 'ios:core-simulator:OTHER')] };
		model.onDidChangeEmitter.fire();
		const shared = state(button);

		button.element.querySelector<HTMLElement>('.paradis-simulator-share-list')!.click();
		const popover = container.querySelector<HTMLElement>('.paradis-simulator-share-popover')!;
		const rows = [...popover.querySelectorAll('.pbs-row')].map(row => [row.querySelector('.pbs-name')?.textContent, row.querySelector('.pbs-kind')?.textContent]);
		popover.querySelectorAll<HTMLButtonElement>('.pbs-unshare')[1].click();
		await Promise.resolve();
		const afterUnshare = { rows: popover.querySelectorAll('.pbs-row').length, badge: state(button).badge };

		popover.querySelector<HTMLButtonElement>('.pbs-link')!.click();
		const closed = !container.querySelector('.paradis-simulator-share-popover');

		assert.deepStrictEqual({ beforeDevice: beforeDevice.hidden, unshared, shared, rows, detached: model.detached, afterUnshare, closed, commands }, {
			beforeDevice: true,
			unshared: { hidden: false, checked: false, badge: '', label: 'ターミナルのペインに渡す', listHidden: true },
			shared: { hidden: false, checked: true, badge: '2', label: 'ペインに渡しています: 2 件（クリックで渡す先の設定）', listHidden: false },
			rows: [['Paracode-SSH', 'このペインの操作先'], ['para-code-37', '渡し済み（このペインの操作先は別の端末）']],
			detached: [`pane-b ${IPHONE}`],
			afterUnshare: { rows: 1, badge: '1' },
			closed: true,
			// 本体と、一覧の「ほかのペインに渡す…」は、どちらもこの端末を開いたダイアログ
			commands: [[PARADIS_MOBILE_OPEN_ATTACH_DIALOG_COMMAND_ID, IPHONE], [PARADIS_MOBILE_OPEN_ATTACH_DIALOG_COMMAND_ID, IPHONE]],
		});
	});

	// 最後のペインへ渡すのをやめたら一覧を閉じ、▾ を隠す
	test('closes the list and hides the chevron when no pane holds the device any more', async () => {
		const model = store.add(new class extends FakeModel implements IDisposable { dispose() { this.onDidChangeEmitter.dispose(); } }());
		model.snapshot = { devices: [], attachments: [attachment('pane-a', IPHONE, true)] };
		const { button } = create(model);
		button.setDevice(IPHONE);
		button.element.querySelector<HTMLElement>('.paradis-simulator-share-list')!.click();
		container.querySelector<HTMLButtonElement>('.paradis-simulator-share-popover .pbs-unshare')!.click();
		await Promise.resolve();
		assert.deepStrictEqual({ open: !!container.querySelector('.paradis-simulator-share-popover'), state: state(button) }, {
			open: false,
			state: { hidden: false, checked: false, badge: '', label: 'ターミナルのペインに渡す', listHidden: true },
		});
	});
});
