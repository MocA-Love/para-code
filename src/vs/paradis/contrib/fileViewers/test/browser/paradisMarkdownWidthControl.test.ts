/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { IAction } from '../../../../../base/common/actions.js';
import { AppResourcePath, FileAccess } from '../../../../../base/common/network.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { IContextMenuDelegate } from '../../../../../base/browser/contextmenu.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import '../../browser/paradisMarkdownWidthConfiguration.js';
import { ParadisMarkdownWidthControl } from '../../browser/paradisMarkdownWidthControl.js';
import { createParadisViewerToolbar } from '../../browser/paradisViewerToolbar.js';
import { PARADIS_MARKDOWN_WIDTH_SETTING, ParadisMarkdownWidth } from '../../common/paradisMarkdownWidth.js';

// 帯の高さと組の高さは土台のトークン（.monaco-workbench に置かれる）から読むので、実物の CSS を読み込む。
const STYLESHEETS: AppResourcePath[] = ['vs/paradis/browser/media/paradisTokens.css'];

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

suite('ParadisMarkdownWidthControl', () => {
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

	function createControl(width: number, value: ParadisMarkdownWidth, chosen: ParadisMarkdownWidth[], menus: IContextMenuDelegate[] = []) {
		const host = mainWindow.document.createElement('div');
		host.style.width = `${width}px`;
		workbench.appendChild(host);
		const toolbar = createParadisViewerToolbar(host, 'example-bar');
		const contextMenuService = { showContextMenu: (delegate: IContextMenuDelegate) => menus.push(delegate) } as unknown as IContextMenuService;
		const control = store.add(new ParadisMarkdownWidthControl(toolbar.end, value, width => chosen.push(width), contextMenuService));
		return { toolbar, control, segmented: toolbar.end.querySelector<HTMLElement>('.paradis-markdown-width')! };
	}

	test('the default width setting is registered as an enum that defaults to the readable 882px', () => {
		const schema = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).getConfigurationProperties()[PARADIS_MARKDOWN_WIDTH_SETTING];
		assert.deepStrictEqual({ type: schema?.type, enum: schema?.enum, default: schema?.default, labels: schema?.enumDescriptions?.length }, {
			type: 'string',
			enum: ['readable', 'wide', 'full'],
			default: 'readable',
			labels: 3,
		});
	});

	test('wide bars show the segmented control in a 32px bar, bars of 420px or less fold it into one button', () => {
		const wide = createControl(800, 'readable', []);
		const narrow = createControl(400, 'readable', []);
		const display = (element: Element) => mainWindow.getComputedStyle(element).display;
		assert.deepStrictEqual({
			barHeight: wide.toolbar.element.getBoundingClientRect().height,
			segmentedHeight: wide.segmented.getBoundingClientRect().height,
			wide: [display(wide.segmented), display(wide.control.foldButton)],
			narrow: [display(narrow.segmented), display(narrow.control.foldButton)],
			labels: [...wide.segmented.querySelectorAll('button')].map(button => [button.textContent, button.title, button.getAttribute('aria-pressed')]),
			fold: [narrow.control.foldButton.getAttribute('aria-haspopup'), narrow.control.foldButton.getAttribute('aria-label')],
		}, {
			barHeight: 32,
			segmentedHeight: 28,
			// Flex items are blockified, so the shown control reads as `flex`.
			wide: ['flex', 'none'],
			narrow: ['none', 'flex'],
			labels: [
				['読みやすい', '読みやすい幅（882px）', 'true'],
				['広い', '広い（1280px）', 'false'],
				['全幅', '全幅（窓いっぱい）', 'false'],
			],
			fold: ['menu', '本文の幅'],
		});
	});

	test('the folded menu checks the current width, and choosing from it or from the group reports the width once', () => {
		const chosen: ParadisMarkdownWidth[] = [];
		const menus: IContextMenuDelegate[] = [];
		const { control, segmented } = createControl(400, 'wide', chosen, menus);
		control.foldButton.click();
		const actions = menus[0].getActions() as IAction[];
		const before = actions.map(action => [action.label, action.class?.includes('codicon-check') ?? false]);
		const expandedWhileOpen = control.foldButton.getAttribute('aria-expanded');
		actions[2].run();
		menus[0].onHide?.(false);
		// Choosing the width that is already shown does not report it again.
		(segmented.querySelectorAll('button')[2] as HTMLButtonElement).click();
		(segmented.querySelectorAll('button')[0] as HTMLButtonElement).click();
		// Setting the value from the setting does not report it as a choice.
		control.value = 'wide';
		assert.deepStrictEqual({
			before,
			expandedWhileOpen,
			expandedAfter: control.foldButton.getAttribute('aria-expanded'),
			chosen,
			value: control.value,
			pressed: [...segmented.querySelectorAll('button')].map(button => button.getAttribute('aria-pressed')),
		}, {
			before: [['読みやすい幅（882px）', false], ['広い（1280px）', true], ['全幅（窓いっぱい）', false]],
			expandedWhileOpen: 'true',
			expandedAfter: 'false',
			chosen: ['full', 'readable'],
			value: 'wide',
			pressed: ['false', 'true', 'false'],
		});
	});
});
