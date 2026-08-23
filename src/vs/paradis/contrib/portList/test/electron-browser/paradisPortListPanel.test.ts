/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import * as dom from '../../../../../base/browser/dom.js';
import { IManagedHover } from '../../../../../base/browser/ui/hover/hover.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IParadisPortListSnapshot } from '../../common/paradisPortList.js';
import { ParadisPortListPanel } from '../../electron-browser/paradisPortListPanel.js';

interface IPanelFixture {
	readonly root: HTMLElement;
	setViewport(viewportWidth: number, anchorRight: number): void;
	dispose(): void;
}

function createPanelFixture(): IPanelFixture {
	const root = document.createElement('div');
	document.body.appendChild(root);
	const window = dom.getWindow(root);
	const anchor = document.createElement('button');
	root.appendChild(anchor);
	let anchorRight = 300;
	anchor.getBoundingClientRect = () => new DOMRect(anchorRight - 20, 10, 20, 20);
	const panel = new ParadisPortListPanel(
		anchor,
		{
			initialSnapshot: longRiskySnapshot,
			viaRemote: false,
			onManualRefresh() { },
			onClose() { },
			onKill() { },
			onKillAll() { },
		},
		upcastPartial<ILayoutService>({ activeContainer: root }),
		upcastPartial<IHoverService>({ setupManagedHover: () => upcastPartial<IManagedHover>({ dispose() { } }) }),
	);

	return {
		root,
		setViewport(viewportWidth: number, nextAnchorRight: number): void {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
			anchorRight = nextAnchorRight;
			window.dispatchEvent(new Event('resize'));
		},
		dispose(): void {
			panel.dispose();
			root.remove();
		},
	};
}

const longRiskySnapshot: IParadisPortListSnapshot = {
	entries: [{
		port: 65535,
		proto: 'TCP',
		pid: 4321,
		processName: 'a-very-long-process-name-that-must-not-push-the-kill-button-outside-the-panel',
		address: '0.0.0.0:65535',
		risky: true,
	}],
	collectedAt: 0,
};

function loadPanelStylesheet(): Promise<HTMLLinkElement> {
	const stylesheet = document.createElement('link');
	stylesheet.rel = 'stylesheet';
	stylesheet.href = new URL('../../electron-browser/media/paradisPortList.css', import.meta.url).href;
	const loaded = new Promise<void>((resolve, reject) => {
		stylesheet.addEventListener('load', () => resolve(), { once: true });
		stylesheet.addEventListener('error', () => reject(new Error('Failed to load port list stylesheet')), { once: true });
	});
	document.head.appendChild(stylesheet);
	return loaded.then(() => stylesheet);
}

function compactMediaRule(stylesheet: HTMLLinkElement): CSSMediaRule | undefined {
	for (const rule of Array.from(stylesheet.sheet?.cssRules ?? [])) {
		if (rule instanceof CSSMediaRule && rule.conditionText.includes('max-width: 455px') && rule.conditionText.includes('pointer: coarse')) {
			return rule;
		}
	}
	return undefined;
}

suite('Paradis port list panel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps its border box and compact row controls inside the viewport after resize', async () => {
		const stylesheet = await loadPanelStylesheet();
		const window = dom.getActiveWindow();
		const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
		const fixture = createPanelFixture();
		try {
			let panelElement = fixture.root.querySelector<HTMLElement>('.paradis-port-list-panel')!;
			let panelRect = panelElement.getBoundingClientRect();
			assert.deepStrictEqual({ left: panelRect.left, width: panelRect.width, right: panelRect.right }, { left: 8, width: 304, right: 312 });

			fixture.setViewport(390, 370);
			panelElement = fixture.root.querySelector<HTMLElement>('.paradis-port-list-panel')!;
			panelRect = panelElement.getBoundingClientRect();
			assert.deepStrictEqual({ left: panelRect.left, width: panelRect.width, right: panelRect.right }, { left: 8, width: 374, right: 382 });

			const processElement = fixture.root.querySelector<HTMLElement>('.ppl-proc')!;
			const killButton = fixture.root.querySelector<HTMLButtonElement>('.ppl-kill-btn')!;
			const killRect = killButton.getBoundingClientRect();
			assert.ok(killRect.left >= panelRect.left && killRect.right <= panelRect.right);
			assert.deepStrictEqual({ minWidth: window.getComputedStyle(processElement).minWidth, flexShrink: window.getComputedStyle(killButton).flexShrink }, { minWidth: '0px', flexShrink: '0' });
			assert.strictEqual(killButton.getAttribute('aria-label'), 'PID 4321 を終了');
			assert.strictEqual(killButton.tabIndex, 0);
			killButton.focus();
			assert.strictEqual(document.activeElement, killButton);

			const compactRule = compactMediaRule(stylesheet);
			assert.ok(compactRule);
			const compactKillRule = Array.from(compactRule.cssRules).find(rule => rule instanceof CSSStyleRule && rule.selectorText === '.paradis-port-list-panel .ppl-kill-btn') as CSSStyleRule | undefined;
			assert.deepStrictEqual({ width: compactKillRule?.style.width, height: compactKillRule?.style.height }, { width: '44px', height: '44px' });
			compactRule.media.mediaText = 'all';
			const compactKillRect = killButton.getBoundingClientRect();
			assert.ok(compactKillRect.width >= 44 && compactKillRect.height >= 44);
			assert.ok(compactKillRect.left >= panelRect.left && compactKillRect.right <= panelRect.right);
		} finally {
			if (originalInnerWidth) {
				Object.defineProperty(window, 'innerWidth', originalInnerWidth);
			} else {
				delete (window as { innerWidth?: number }).innerWidth;
			}
			fixture.dispose();
			stylesheet.remove();
		}
	});
});
