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
import { IParadisPortEntry, IParadisPortListSnapshot } from '../../common/paradisPortList.js';
import { ParadisPortListPanel } from '../../electron-browser/paradisPortListPanel.js';

interface IPanelFixture {
	readonly root: HTMLElement;
	readonly killedEntries: readonly IParadisPortEntry[];
	readonly anchorRectReadCount: number;
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
	let anchorRectReadCount = 0;
	const killedEntries: IParadisPortEntry[] = [];
	anchor.getBoundingClientRect = () => {
		anchorRectReadCount++;
		return new DOMRect(anchorRight - 20, 10, 20, 20);
	};
	const panel = new ParadisPortListPanel(
		anchor,
		{
			initialSnapshot: longRiskySnapshot,
			viaRemote: false,
			onManualRefresh() { },
			onClose() { },
			onKill(entry) { killedEntries.push(entry); },
			onKillAll() { },
		},
		upcastPartial<ILayoutService>({ activeContainer: root }),
		upcastPartial<IHoverService>({ setupManagedHover: () => upcastPartial<IManagedHover>({ dispose() { } }) }),
	);

	return {
		root,
		killedEntries,
		get anchorRectReadCount(): number { return anchorRectReadCount; },
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

const longRiskyEntry: IParadisPortEntry = {
	port: 65535,
	proto: 'TCP',
	pid: 4321,
	processName: 'a-very-long-process-name-that-must-not-push-the-kill-button-outside-the-panel',
	address: '0.0.0.0:65535',
	risky: true,
};

const longRiskySnapshot: IParadisPortListSnapshot = {
	entries: [longRiskyEntry],
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

function mediaRule(stylesheet: HTMLLinkElement, predicate: (rule: CSSMediaRule) => boolean): CSSMediaRule | undefined {
	for (const rule of Array.from(stylesheet.sheet?.cssRules ?? [])) {
		if (rule instanceof CSSMediaRule && predicate(rule)) {
			return rule;
		}
	}
	return undefined;
}

function nestedStyleRule(mediaRule: CSSMediaRule, selector: string): CSSStyleRule | undefined {
	return Array.from(mediaRule.cssRules).find(rule => rule instanceof CSSStyleRule && rule.selectorText === selector) as CSSStyleRule | undefined;
}

function compactRowMediaRule(stylesheet: HTMLLinkElement): CSSMediaRule | undefined {
	return mediaRule(stylesheet, rule => rule.conditionText === '(max-width: 455px)' && nestedStyleRule(rule, '.paradis-port-list-panel .ppl-row') !== undefined);
}

function killTargetMediaRule(stylesheet: HTMLLinkElement): CSSMediaRule | undefined {
	return mediaRule(stylesheet, rule => rule.conditionText.includes('pointer: coarse') && nestedStyleRule(rule, '.paradis-port-list-panel .ppl-kill-btn') !== undefined);
}

function rowStructure(window: Window, root: HTMLElement): { readonly gap: string; readonly paddingLeft: string; readonly paddingRight: string; readonly portWidth: string; readonly pidWidth: string; readonly badgeMaxWidth: string; readonly badgeOverflow: string; readonly badgeTextOverflow: string } {
	const row = root.querySelector<HTMLElement>('.ppl-row')!;
	const port = root.querySelector<HTMLElement>('.ppl-port')!;
	const pid = root.querySelector<HTMLElement>('.ppl-pid')!;
	const badge = root.querySelector<HTMLElement>('.ppl-risk-badge')!;
	const rowStyle = window.getComputedStyle(row);
	const portStyle = window.getComputedStyle(port);
	const pidStyle = window.getComputedStyle(pid);
	const badgeStyle = window.getComputedStyle(badge);
	return {
		gap: rowStyle.gap,
		paddingLeft: rowStyle.paddingLeft,
		paddingRight: rowStyle.paddingRight,
		portWidth: portStyle.width,
		pidWidth: pidStyle.width,
		badgeMaxWidth: badgeStyle.maxWidth,
		badgeOverflow: badgeStyle.overflow,
		badgeTextOverflow: badgeStyle.textOverflow,
	};
}

suite('Paradis port list panel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps wide coarse-pointer rows at the wide layout dimensions', async () => {
		const stylesheet = await loadPanelStylesheet();
		const window = dom.getActiveWindow();
		const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
		const fixture = createPanelFixture();
		try {
			const wideFineStructure = rowStructure(window, fixture.root);
			const compactRule = compactRowMediaRule(stylesheet);
			const targetRule = killTargetMediaRule(stylesheet);
			assert.ok(compactRule);
			assert.ok(targetRule);
			targetRule.media.mediaText = 'all';
			assert.deepStrictEqual(rowStructure(window, fixture.root), wideFineStructure);
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

	test('keeps compact risky rows interactive and fully contained', async () => {
		const stylesheet = await loadPanelStylesheet();
		const window = dom.getActiveWindow();
		const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
		const fixture = createPanelFixture();
		try {
			const compactRule = compactRowMediaRule(stylesheet);
			const targetRule = killTargetMediaRule(stylesheet);
			assert.ok(compactRule);
			assert.ok(targetRule);
			compactRule.media.mediaText = 'all';
			targetRule.media.mediaText = 'all';

			const panel = fixture.root.querySelector<HTMLElement>('.paradis-port-list-panel')!;
			const processElement = fixture.root.querySelector<HTMLElement>('.ppl-proc')!;
			const killButton = fixture.root.querySelector<HTMLButtonElement>('.ppl-kill-btn')!;
			const panelRect = panel.getBoundingClientRect();
			const killRect = killButton.getBoundingClientRect();
			assert.deepStrictEqual({ left: panelRect.left, width: panelRect.width, right: panelRect.right }, { left: 8, width: 304, right: 312 });
			assert.ok(killRect.width >= 44 && killRect.height >= 44);
			assert.ok(killRect.left >= panelRect.left && killRect.right <= panelRect.right);
			assert.ok(processElement.scrollWidth > processElement.clientWidth);
			assert.deepStrictEqual({ textOverflow: window.getComputedStyle(processElement).textOverflow, minWidth: window.getComputedStyle(processElement).minWidth, flexShrink: window.getComputedStyle(killButton).flexShrink }, { textOverflow: 'ellipsis', minWidth: '0px', flexShrink: '0' });
			assert.deepStrictEqual(rowStructure(window, fixture.root), {
				gap: '6px',
				paddingLeft: '10px',
				paddingRight: '10px',
				portWidth: '46px',
				pidWidth: '48px',
				badgeMaxWidth: '64px',
				badgeOverflow: 'hidden',
				badgeTextOverflow: 'ellipsis',
			});
			assert.strictEqual(killButton.getAttribute('aria-label'), 'PID 4321 を終了');
			assert.strictEqual(killButton.tabIndex, 0);
			killButton.focus();
			assert.strictEqual(document.activeElement, killButton);
			killButton.click();
			assert.deepStrictEqual(fixture.killedEntries, [longRiskyEntry]);
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

	test('repositions on resize and disposes the resize listener', async () => {
		const stylesheet = await loadPanelStylesheet();
		const window = dom.getActiveWindow();
		const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
		const fixture = createPanelFixture();
		try {
			const initialRectReads = fixture.anchorRectReadCount;
			assert.ok(initialRectReads > 0);

			fixture.setViewport(390, 370);
			const panelRect = fixture.root.querySelector<HTMLElement>('.paradis-port-list-panel')!.getBoundingClientRect();
			assert.deepStrictEqual({ left: panelRect.left, width: panelRect.width, right: panelRect.right }, { left: 8, width: 374, right: 382 });
			assert.strictEqual(fixture.anchorRectReadCount, initialRectReads + 1);

			fixture.dispose();
			const disposedRectReads = fixture.anchorRectReadCount;
			fixture.setViewport(320, 300);
			assert.strictEqual(fixture.anchorRectReadCount, disposedRectReads);
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
