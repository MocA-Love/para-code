/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../base/browser/window.js';
import { AppResourcePath, FileAccess } from '../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { ParadisModalSize, paradisModalClasses } from '../../browser/paradisModal.js';
import { ParadisSwitch } from '../../browser/paradisSwitch.js';

// 寸法を computed style で確かめるため、部品の CSS を link で読み込んで読み込み終わりを待つ。
const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/browser/media/paradisSwitch.css',
	'vs/paradis/browser/media/paradisModal.css',
];

function loadStylesheet(path: AppResourcePath): Promise<HTMLLinkElement> {
	const link = mainWindow.document.createElement('link');
	link.rel = 'stylesheet';
	link.href = FileAccess.asBrowserUri(path).toString(true);
	const loaded = new Promise<HTMLLinkElement>((resolve, reject) => {
		link.addEventListener('load', () => resolve(link), { once: true });
		link.addEventListener('error', () => reject(new Error(`could not load ${path}`)), { once: true });
	});
	mainWindow.document.head.appendChild(link);
	return loaded;
}

suite('Paradis UI parts', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let links: HTMLLinkElement[] = [];

	setup(async () => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		links = await Promise.all(STYLESHEETS.map(loadStylesheet));
	});

	teardown(() => {
		workbench.remove();
		for (const link of links) {
			link.remove();
		}
		links = [];
	});

	test('switch: role, aria-checked, user changes, programmatic changes and the disabled state', () => {
		const toggle = store.add(new ParadisSwitch(workbench, { checked: false, ariaLabel: 'Enable' }));
		const changes: boolean[] = [];
		store.add(toggle.onDidChange(checked => changes.push(checked)));
		const snapshot = () => ({ checked: toggle.checked, aria: toggle.element.getAttribute('aria-checked'), enabled: toggle.enabled });

		const initial = snapshot();
		toggle.element.click();
		const afterClick = snapshot();
		toggle.checked = false;
		const afterSetter = snapshot();
		toggle.enabled = false;
		toggle.element.click();
		const whileDisabled = snapshot();

		assert.deepStrictEqual({
			tag: toggle.element.tagName,
			type: toggle.element.type,
			role: toggle.element.getAttribute('role'),
			label: toggle.element.getAttribute('aria-label'),
			initial, afterClick, afterSetter, whileDisabled, changes,
		}, {
			tag: 'BUTTON',
			type: 'button',
			role: 'switch',
			label: 'Enable',
			initial: { checked: false, aria: 'false', enabled: true },
			afterClick: { checked: true, aria: 'true', enabled: true },
			afterSetter: { checked: false, aria: 'false', enabled: true },
			whileDisabled: { checked: false, aria: 'false', enabled: false },
			changes: [true],
		});
	});

	test('switch: 36x20 with a 16px knob that moves to the right when on; dimmed when disabled', () => {
		const off = store.add(new ParadisSwitch(workbench, { checked: false }));
		const on = store.add(new ParadisSwitch(workbench, { checked: true, disabled: true }));
		const measure = (toggle: ParadisSwitch) => {
			const box = toggle.element.getBoundingClientRect();
			const knob = mainWindow.getComputedStyle(toggle.element, '::after');
			return { width: box.width, height: box.height, knob: `${knob.width} ${knob.height}`, knobLeft: knob.left, opacity: mainWindow.getComputedStyle(toggle.element).opacity };
		};
		assert.deepStrictEqual({ off: measure(off), on: measure(on) }, {
			off: { width: 36, height: 20, knob: '16px 16px', knobLeft: '1px', opacity: '1' },
			on: { width: 36, height: 20, knob: '16px 16px', knobLeft: '17px', opacity: '0.4' },
		});
	});

	test('switch: aria-labelledby points at a visible label', () => {
		const toggle = store.add(new ParadisSwitch(workbench, { checked: false, ariaLabelledBy: 'row-title row-desc' }));
		assert.deepStrictEqual({ labelledBy: toggle.element.getAttribute('aria-labelledby'), label: toggle.element.getAttribute('aria-label') }, { labelledBy: 'row-title row-desc', label: null });
	});

	test('switch: in high contrast themes on and off differ by the frame and knob colors, not only by the knob position', () => {
		workbench.classList.add('hc-black');
		workbench.style.setProperty('--vscode-contrastBorder', 'rgb(111, 195, 223)');
		workbench.style.setProperty('--vscode-contrastActiveBorder', 'rgb(243, 133, 24)');
		workbench.style.setProperty('--vscode-foreground', 'rgb(255, 255, 255)');
		const off = store.add(new ParadisSwitch(workbench, { checked: false }));
		const on = store.add(new ParadisSwitch(workbench, { checked: true }));
		const colors = (toggle: ParadisSwitch) => ({ frame: mainWindow.getComputedStyle(toggle.element).borderTopColor, knob: mainWindow.getComputedStyle(toggle.element, '::after').backgroundColor });
		assert.deepStrictEqual({ off: colors(off), on: colors(on) }, {
			off: { frame: 'rgb(111, 195, 223)', knob: 'rgb(255, 255, 255)' },
			on: { frame: 'rgb(243, 133, 24)', knob: 'rgb(243, 133, 24)' },
		});
	});

	test('modal size tiers: S follows the content, M has a fixed height, L uses the usage dashboard size', () => {
		const make = (size: ParadisModalSize) => {
			const box = mainWindow.document.createElement('div');
			box.classList.add(...paradisModalClasses(size));
			workbench.appendChild(box);
			const style = mainWindow.getComputedStyle(box);
			return { className: box.className, width: style.width, height: style.height, maxHeight: style.maxHeight };
		};
		const vw = mainWindow.innerWidth / 100;
		const vh = mainWindow.innerHeight / 100;
		const px = (value: number) => `${Math.round(value)}px`;
		const clamp = (min: number, value: number, max: number) => Math.min(Math.max(min, value), max);
		const actual = [make(ParadisModalSize.Small), make(ParadisModalSize.Medium), make(ParadisModalSize.Large)].map(box => ({
			...box,
			width: px(parseFloat(box.width)),
			height: px(parseFloat(box.height)),
			maxHeight: px(parseFloat(box.maxHeight)),
		}));
		assert.deepStrictEqual(actual, [
			{ className: 'paradis-modal paradis-modal-s', width: px(Math.min(480, 94 * vw)), height: '0px', maxHeight: px(88 * vh) },
			{ className: 'paradis-modal paradis-modal-m', width: px(Math.min(880, 94 * vw)), height: px(Math.min(clamp(520, 72 * vh, 820), 92 * vh)), maxHeight: px(92 * vh) },
			{ className: 'paradis-modal paradis-modal-l', width: px(Math.min(clamp(1040, 78 * vw, 2000), 95 * vw)), height: px(Math.min(clamp(726, 88 * vh, 1400), 92 * vh)), maxHeight: px(92 * vh) },
		]);
	});
});
