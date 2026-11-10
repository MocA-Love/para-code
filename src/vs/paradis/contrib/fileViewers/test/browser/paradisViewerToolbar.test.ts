/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { deepStrictEqual } from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	appendParadisViewerToolbarGroup,
	appendParadisViewerToolbarIconButton,
	appendParadisViewerToolbarOption,
	appendParadisViewerToolbarPanelToggle,
	appendParadisViewerToolbarPercent,
	appendParadisViewerToolbarSeparator,
	createParadisViewerToolbar,
	setParadisViewerToolbarHeight,
	setParadisViewerToolbarOptionChecked,
} from '../../browser/paradisViewerToolbar.js';

// The bar's height is the UI kit's token (declared on .monaco-workbench), so the real stylesheet is loaded.
const TOKENS: AppResourcePath = 'vs/paradis/browser/media/paradisTokens.css';

suite('ParadisViewerToolbar', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let workbench: HTMLElement;
	let tokens: HTMLLinkElement;

	setup(async () => {
		workbench = mainWindow.document.createElement('div');
		workbench.className = 'monaco-workbench';
		mainWindow.document.body.appendChild(workbench);
		tokens = mainWindow.document.createElement('link');
		tokens.rel = 'stylesheet';
		tokens.href = FileAccess.asBrowserUri(TOKENS).toString(true);
		const loaded = new Promise<void>((resolve, reject) => {
			tokens.addEventListener('load', () => resolve(), { once: true });
			tokens.addEventListener('error', () => reject(new Error(`could not load ${TOKENS}`)), { once: true });
		});
		mainWindow.document.head.appendChild(tokens);
		await loaded;
	});

	teardown(() => {
		workbench.remove();
		tokens.remove();
	});

	function host(width = 800): HTMLElement {
		const element = mainWindow.document.createElement('div');
		element.style.width = `${width}px`;
		element.style.position = 'relative';
		workbench.appendChild(element);
		return element;
	}

	test('builds a 32px bar with the kit\'s 24px buttons, a 44px percentage and the right accessibility state', () => {
		const root = host();
		try {
			const toolbar = createParadisViewerToolbar(root, 'example-bar', 'Example');
			const filter = appendParadisViewerToolbarOption(toolbar.end, 'Rules', Codicon.checklist);
			setParadisViewerToolbarOptionChecked(filter, true);
			const panel = appendParadisViewerToolbarPanelToggle(toolbar.end, 'Changes');
			setParadisViewerToolbarOptionChecked(panel, true);
			const zoom = appendParadisViewerToolbarGroup(toolbar.end);
			const button = appendParadisViewerToolbarIconButton(zoom, Codicon.zoomIn, 'Zoom In');
			const percent = appendParadisViewerToolbarPercent(zoom, 'Reset Zoom');
			percent.textContent = '100%';

			deepStrictEqual({
				bar: [toolbar.element.getBoundingClientRect().height, toolbar.element.getAttribute('role'), toolbar.element.getAttribute('aria-label'), root.classList.contains('paradis-viewer-toolbar-host')],
				filter: [filter.getAttribute('aria-pressed'), filter.classList.contains('checked'), filter.getBoundingClientRect().height, filter.classList.contains('paradis-button-ghost')],
				panel: [panel.getAttribute('aria-expanded'), panel.hasAttribute('aria-pressed')],
				button: [button.getBoundingClientRect().width, button.getBoundingClientRect().height, button.getAttribute('aria-label'), !!button.querySelector('.codicon-zoom-in')],
				percent: percent.getBoundingClientRect().width >= 44,
			}, {
				bar: [32, 'toolbar', 'Example', true],
				filter: ['true', true, 24, true],
				panel: ['true', false],
				button: [24, 24, 'Zoom In', true],
				percent: true,
			});
		} finally {
			root.remove();
		}
	});

	test('hides an empty group together with the separator before it', () => {
		const root = host();
		try {
			const toolbar = createParadisViewerToolbar(root, 'example-bar');
			appendParadisViewerToolbarIconButton(appendParadisViewerToolbarGroup(toolbar.end), Codicon.zoomIn, 'Zoom In');
			const separatorBeforeEmpty = appendParadisViewerToolbarSeparator(toolbar.end);
			const empty = appendParadisViewerToolbarGroup(toolbar.end);
			const separatorBeforeFilled = appendParadisViewerToolbarSeparator(toolbar.end);
			appendParadisViewerToolbarIconButton(appendParadisViewerToolbarGroup(toolbar.end), Codicon.linkExternal, 'Open');
			const display = (element: HTMLElement) => mainWindow.getComputedStyle(element).display;
			deepStrictEqual([display(separatorBeforeEmpty), display(empty), display(separatorBeforeFilled)], ['none', 'none', 'block']);
		} finally {
			root.remove();
		}
	});

	test('folds labels and the percentage in a narrow pane but keeps every button visible', () => {
		const root = host(360);
		try {
			const toolbar = createParadisViewerToolbar(root, 'example-bar');
			const withIcon = appendParadisViewerToolbarOption(toolbar.end, 'Rules', Codicon.checklist);
			const withoutIcon = appendParadisViewerToolbarOption(toolbar.end, 'Changes');
			const percent = appendParadisViewerToolbarPercent(toolbar.end, 'Reset Zoom');
			const display = (element: Element | null) => element ? mainWindow.getComputedStyle(element).display : 'missing';
			deepStrictEqual({
				iconLabel: display(withIcon.querySelector('.paradis-viewer-toolbar-option-label')),
				textLabel: display(withoutIcon.querySelector('.paradis-viewer-toolbar-option-label')),
				percent: display(percent),
			}, { iconLabel: 'none', textLabel: 'block', percent: 'none' });
		} finally {
			root.remove();
		}
	});

	test('lets the find widget follow the bar height', () => {
		const root = host();
		try {
			createParadisViewerToolbar(root, 'example-bar');
			const find = mainWindow.document.createElement('div');
			find.className = 'paradis-office-find-widget';
			find.style.position = 'absolute';
			root.appendChild(find);
			const before = mainWindow.getComputedStyle(find).top;
			setParadisViewerToolbarHeight(root, 52);
			deepStrictEqual([before, mainWindow.getComputedStyle(find).top], ['36px', '56px']);
		} finally {
			root.remove();
		}
	});
});
