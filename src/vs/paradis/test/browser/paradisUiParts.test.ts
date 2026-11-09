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
import { Codicon } from '../../../base/common/codicons.js';
import { renderParadisActionButton } from '../../browser/paradisActionButton.js';
import { createParadisChip, createParadisStatusDot, ParadisCountBadge, paradisCountLabel } from '../../browser/paradisBadges.js';
import { ParadisButton } from '../../browser/paradisButton.js';
import { ParadisCheck } from '../../browser/paradisCheck.js';
import { ParadisInputField } from '../../browser/paradisInputField.js';
import { ParadisModalSize, paradisModalClasses } from '../../browser/paradisModal.js';
import { ParadisSwitch } from '../../browser/paradisSwitch.js';

// 寸法を computed style で確かめるため、部品の CSS を link で読み込んで読み込み終わりを待つ。
const STYLESHEETS: AppResourcePath[] = [
	'vs/paradis/browser/media/paradisTokens.css',
	'vs/paradis/browser/media/paradisButton.css',
	'vs/paradis/browser/media/paradisBadges.css',
	'vs/paradis/browser/media/paradisSwitch.css',
	'vs/paradis/browser/media/paradisInputField.css',
	'vs/paradis/browser/media/paradisCheck.css',
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

	test('switch: 32x18 with a 14px knob that moves to the right when on; dimmed when disabled', () => {
		const off = store.add(new ParadisSwitch(workbench, { checked: false }));
		const on = store.add(new ParadisSwitch(workbench, { checked: true, disabled: true }));
		const measure = (toggle: ParadisSwitch) => {
			const box = toggle.element.getBoundingClientRect();
			const knob = mainWindow.getComputedStyle(toggle.element, '::after');
			return { width: box.width, height: box.height, knob: `${knob.width} ${knob.height}`, knobLeft: knob.left, opacity: mainWindow.getComputedStyle(toggle.element).opacity };
		};
		assert.deepStrictEqual({ off: measure(off), on: measure(on) }, {
			off: { width: 32, height: 18, knob: '14px 14px', knobLeft: '1px', opacity: '1' },
			on: { width: 32, height: 18, knob: '14px 14px', knobLeft: '15px', opacity: '0.4' },
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

	test('input field: the upstream InputBox inside a 32px frame (28px small), no inline colors, a gray focus frame', () => {
		const field = store.add(new ParadisInputField(workbench, { ariaLabel: '検索', placeholder: '設定を検索', icon: Codicon.search, value: 'abc' }));
		const small = store.add(new ParadisInputField(workbench, { ariaLabel: 'パス', small: true }));
		const changes: string[] = [];
		store.add(field.onDidChange(value => changes.push(value)));
		field.inputElement.value = 'abcd';
		field.inputElement.dispatchEvent(new Event('input'));
		small.enabled = false;
		const inputBox = field.element.querySelector<HTMLElement>('.monaco-inputbox')!;
		assert.deepStrictEqual({
			className: field.element.className,
			icon: field.element.firstElementChild?.getAttribute('aria-hidden'),
			ariaLabel: field.inputElement.getAttribute('aria-label'),
			placeholder: field.inputElement.placeholder,
			value: field.value,
			changes,
			inlineColors: inputBox.style.backgroundColor + inputBox.style.color,
			heights: [field.element.getBoundingClientRect().height, small.element.getBoundingClientRect().height],
			radius: mainWindow.getComputedStyle(field.element).borderTopLeftRadius,
			smallDisabled: [small.enabled, small.inputElement.disabled, small.element.classList.contains('disabled')],
		}, {
			className: 'paradis-field paradis-focus-subtle-within',
			icon: 'true',
			ariaLabel: '検索',
			placeholder: '設定を検索',
			value: 'abcd',
			changes: ['abcd'],
			inlineColors: '',
			heights: [32, 28],
			radius: '6px',
			smallDisabled: [false, true, true],
		});
	});

	test('check: the upstream Checkbox (role, keys, aria) as a 16px box; the label toggles it too; no inline colors', () => {
		const check = store.add(new ParadisCheck(workbench, { label: 'メニューに出す', checked: false }));
		const changes: boolean[] = [];
		store.add(check.onDidChange(checked => changes.push(checked)));
		const box = check.focusableElement;
		const snapshot = () => ({ checked: check.checked, aria: box.getAttribute('aria-checked') });
		box.click();
		const afterBox = snapshot();
		box.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32 }));
		const afterSpace = snapshot();
		check.labelElement.click();
		const afterLabel = snapshot();
		check.checked = false;
		const afterSetter = snapshot();
		check.enabled = false;
		check.labelElement.click();
		const whileDisabled = snapshot();
		const rect = box.getBoundingClientRect();
		assert.deepStrictEqual({
			role: box.getAttribute('role'),
			label: box.getAttribute('aria-label'),
			tabIndex: box.tabIndex,
			focusRing: box.classList.contains('paradis-focus-ring'),
			size: [rect.width, rect.height],
			inlineColors: box.style.backgroundColor + box.style.color + box.style.borderColor,
			afterBox, afterSpace, afterLabel, afterSetter, whileDisabled, changes,
		}, {
			role: 'checkbox',
			label: 'メニューに出す',
			tabIndex: -1,
			focusRing: true,
			size: [16, 16],
			inlineColors: '',
			afterBox: { checked: true, aria: 'true' },
			afterSpace: { checked: false, aria: 'false' },
			afterLabel: { checked: true, aria: 'true' },
			afterSetter: { checked: false, aria: 'false' },
			whileDisabled: { checked: false, aria: 'false' },
			changes: [true, false, true],
		});
	});

	test('modal size tiers: S follows the content, M is 720 with a fixed height, L uses the usage dashboard size', () => {
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
			{ className: 'paradis-modal paradis-modal-s paradis-focus-none', width: px(Math.min(480, 94 * vw)), height: '0px', maxHeight: px(88 * vh) },
			{ className: 'paradis-modal paradis-modal-m paradis-focus-none', width: px(Math.min(720, 94 * vw)), height: px(Math.min(clamp(520, 72 * vh, 820), 92 * vh)), maxHeight: px(92 * vh) },
			{ className: 'paradis-modal paradis-modal-l paradis-focus-none', width: px(Math.min(clamp(1040, 78 * vw, 2000), 95 * vw)), height: px(Math.min(clamp(726, 88 * vh, 1400), 92 * vh)), maxHeight: px(92 * vh) },
		]);
	});

	test('count label: hidden at zero, 99+ beside text, 9+ over an icon', () => {
		const counts = [0, -1, Number.NaN, 1, 9, 10, 99, 100, 140];
		assert.deepStrictEqual({
			inline: counts.map(count => paradisCountLabel(count, 'inline')),
			overlay: counts.map(count => paradisCountLabel(count, 'overlay')),
		}, {
			inline: [undefined, undefined, undefined, '1', '9', '10', '99', '99+', '99+'],
			overlay: [undefined, undefined, undefined, '1', '9', '9+', '9+', '9+', '9+'],
		});
	});

	test('count badge: color only when a person needs to look; plain counts are not filled', () => {
		workbench.style.setProperty('--vscode-paradis-warning', 'rgb(251, 194, 59)');
		workbench.style.setProperty('--vscode-paradis-danger', 'rgb(244, 88, 126)');
		workbench.style.setProperty('--vscode-paradis-textMuted', 'rgb(150, 150, 150)');
		workbench.style.setProperty('--vscode-paradis-canvas', 'rgb(23, 25, 30)');
		const badge = new ParadisCountBadge(workbench, 'inline');
		const read = () => {
			const style = mainWindow.getComputedStyle(badge.element);
			return { text: badge.element.textContent, display: style.display, color: style.color, background: style.backgroundColor, height: style.height };
		};
		const zero = read();
		badge.update(3, 'plain');
		const plain = read();
		badge.update(2, 'attention');
		const attention = read();
		badge.update(140, 'error');
		const error = read();
		assert.deepStrictEqual({ hidden: badge.element.getAttribute('aria-hidden'), zero: zero.display, plain, attention, error }, {
			hidden: 'true',
			zero: 'none',
			plain: { text: '3', display: 'inline-flex', color: 'rgb(150, 150, 150)', background: 'rgba(0, 0, 0, 0)', height: '16px' },
			attention: { text: '2', display: 'inline-flex', color: 'rgb(23, 25, 30)', background: 'rgb(251, 194, 59)', height: '16px' },
			error: { text: '99+', display: 'inline-flex', color: 'rgb(23, 25, 30)', background: 'rgb(244, 88, 126)', height: '16px' },
		});
	});

	test('button: the upstream Button DOM and keys, the kit classes, and no inline colors', () => {
		const button = store.add(new ParadisButton(workbench, { kind: 'primary', label: '保存' }));
		let clicks = 0;
		store.add(button.onDidClick(() => clicks++));
		button.element.dispatchEvent(new MouseEvent('mouseover'));
		button.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13 }));
		button.element.click();
		button.enabled = false;
		button.element.click();
		assert.deepStrictEqual({
			tag: button.element.tagName,
			role: button.element.getAttribute('role'),
			tabIndex: button.element.tabIndex,
			className: button.element.className,
			text: button.element.textContent,
			inlineStyle: button.element.style.backgroundColor + button.element.style.color + button.element.style.border,
			clicks,
		}, {
			tag: 'A',
			role: 'button',
			tabIndex: 0,
			className: 'monaco-button paradis-button paradis-button-primary paradis-focus-ring monaco-text-button disabled',
			text: '保存',
			inlineStyle: '',
			clicks: 2,
		});
	});

	test('button: 28px standard, 24px small, square icon buttons, radius 6', () => {
		const measure = (button: ParadisButton) => {
			const box = button.element.getBoundingClientRect();
			return { height: box.height, radius: mainWindow.getComputedStyle(button.element).borderTopLeftRadius, square: box.width === box.height };
		};
		const kinds = {
			primary: measure(store.add(new ParadisButton(workbench, { kind: 'primary', label: 'Save' }))),
			secondary: measure(store.add(new ParadisButton(workbench, { kind: 'secondary', label: 'Cancel' }))),
			ghost: measure(store.add(new ParadisButton(workbench, { kind: 'ghost', label: 'Details', small: true }))),
			danger: measure(store.add(new ParadisButton(workbench, { kind: 'danger', label: 'Delete' }))),
			icon: measure(store.add(new ParadisButton(workbench, { kind: 'icon', icon: Codicon.refresh, ariaLabel: 'Refresh' }))),
			iconSmall: measure(store.add(new ParadisButton(workbench, { kind: 'icon', icon: Codicon.close, ariaLabel: 'Close', small: true }))),
		};
		assert.deepStrictEqual(kinds, {
			primary: { height: 28, radius: '6px', square: false },
			secondary: { height: 28, radius: '6px', square: false },
			ghost: { height: 24, radius: '6px', square: false },
			danger: { height: 28, radius: '6px', square: false },
			icon: { height: 28, radius: '6px', square: true },
			iconSmall: { height: 24, radius: '6px', square: true },
		});
	});

	test('action button: an ActionBar item drawn as a 24px kit button, the count beside the label or over the icon', () => {
		const textItem = mainWindow.document.createElement('li');
		const iconItem = mainWindow.document.createElement('li');
		workbench.append(textItem, iconItem);
		const text = renderParadisActionButton(textItem, { icon: 'paradis-test-icon', label: 'エージェント一覧', count: true });
		const icon = renderParadisActionButton(iconItem, { icon: Codicon.bell, count: true });
		text.count?.update(3, 'plain');
		icon.count?.update(12, 'attention');
		const box = (element: HTMLElement) => ({ width: Math.round(element.getBoundingClientRect().width), height: element.getBoundingClientRect().height });
		assert.deepStrictEqual({
			textClass: textItem.className,
			iconClass: iconItem.className,
			textCount: [text.count?.element.className, text.count?.element.textContent],
			iconCount: [icon.count?.element.className, icon.count?.element.textContent],
			iconBox: box(iconItem),
			textHeight: box(textItem).height,
			overlayHeight: box(icon.count!.element).height,
			label: text.label?.textContent,
			hasNoInnerButton: textItem.querySelector('a, button') === null && iconItem.querySelector('a, button') === null,
		}, {
			textClass: 'paradis-button paradis-button-ghost paradis-focus-ring paradis-button-small paradis-action-button',
			iconClass: 'paradis-button paradis-button-icon paradis-focus-ring paradis-button-small paradis-action-button',
			textCount: ['paradis-count', '3'],
			iconCount: ['paradis-count paradis-count-overlay attention', '9+'],
			iconBox: { width: 24, height: 24 },
			textHeight: 24,
			overlayHeight: 14,
			label: 'エージェント一覧',
			hasNoInnerButton: true,
		});
	});

	test('a 390px window: long Japanese labels in buttons, chips and status dots are cut, nothing overflows', () => {
		const frame = mainWindow.document.createElement('div');
		frame.style.cssText = 'width: 390px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px;';
		workbench.appendChild(frame);
		const long = 'ワークツリーのフォルダとブランチをまとめて削除してから、元のスペースへ戻ります';
		const button = store.add(new ParadisButton(frame, { kind: 'secondary', label: long }));
		const chip = createParadisChip(frame, long, 'warning');
		const status = createParadisStatusDot(frame, long, 'running');
		const row = mainWindow.document.createElement('div');
		row.style.cssText = 'display: flex; gap: 4px; min-width: 0; max-width: 100%;';
		frame.appendChild(row);
		for (let i = 0; i < 6; i++) {
			createParadisChip(row, `チップの長い名前 ${i}`, 'neutral');
		}
		const frameRight = frame.getBoundingClientRect().right;
		const fits = (element: HTMLElement) => element.getBoundingClientRect().right <= frameRight + 0.5;
		assert.deepStrictEqual({
			scrollWidth: frame.scrollWidth <= 390,
			button: fits(button.element),
			chip: fits(chip),
			status: fits(status),
			row: Array.from(row.children).every(child => fits(child as HTMLElement)),
			chipHeight: chip.getBoundingClientRect().height,
		}, { scrollWidth: true, button: true, chip: true, status: true, row: true, chipHeight: 20 });
	});
});
