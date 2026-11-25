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
import { InMemoryStorageService, IStorageService, StorageScope } from '../../../../../platform/storage/common/storage.js';
import { IParadisPortEntry, IParadisPortListSnapshot } from '../../common/paradisPortList.js';
import { ParadisPortListPanel } from '../../electron-browser/paradisPortListPanel.js';

interface IPanelFixture {
	readonly root: HTMLElement;
	readonly panel: ParadisPortListPanel;
	readonly killedEntries: readonly IParadisPortEntry[];
	readonly killAllRequests: readonly (readonly IParadisPortEntry[])[];
	readonly closes: readonly boolean[];
	readonly anchorRectReadCount: number;
	setViewport(viewportWidth: number, anchorRight: number): void;
	dispose(): void;
}

/** `sharedStorage` を渡すと、保存した並びを次のパネルへ引き継げる（片付けは渡した側）。 */
function createPanelFixture(sharedStorage?: IStorageService): IPanelFixture {
	const ownStorage = sharedStorage ? undefined : new InMemoryStorageService();
	const root = document.createElement('div');
	document.body.appendChild(root);
	const window = dom.getWindow(root);
	const anchor = document.createElement('button');
	root.appendChild(anchor);
	let anchorRight = 300;
	let anchorRectReadCount = 0;
	const killedEntries: IParadisPortEntry[] = [];
	const killAllRequests: (readonly IParadisPortEntry[])[] = [];
	const closes: boolean[] = [];
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
			onClose(restoreFocus) { closes.push(restoreFocus); },
			onKill(entry) { killedEntries.push(entry); },
			onKillAll(entries) { killAllRequests.push(entries); },
		},
		upcastPartial<ILayoutService>({ activeContainer: root }),
		upcastPartial<IHoverService>({ setupManagedHover: () => upcastPartial<IManagedHover>({ dispose() { } }) }),
		sharedStorage ?? ownStorage!,
	);

	return {
		root,
		panel,
		killedEntries,
		killAllRequests,
		closes,
		get anchorRectReadCount(): number { return anchorRectReadCount; },
		setViewport(viewportWidth: number, nextAnchorRight: number): void {
			Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth });
			anchorRight = nextAnchorRight;
			window.dispatchEvent(new Event('resize'));
		},
		dispose(): void {
			panel.dispose();
			ownStorage?.dispose();
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

function rowStructure(window: Window, root: HTMLElement): { readonly gap: string; readonly paddingLeft: string; readonly paddingRight: string; readonly portWidth: string; readonly pidWidth: string; readonly scopeWidth: string; readonly scopeFlexShrink: string } {
	const row = root.querySelector<HTMLElement>('.ppl-row')!;
	const port = root.querySelector<HTMLElement>('.ppl-port')!;
	const pid = root.querySelector<HTMLElement>('.ppl-pid')!;
	const scope = root.querySelector<HTMLElement>('.ppl-row .ppl-scope')!;
	const rowStyle = window.getComputedStyle(row);
	const portStyle = window.getComputedStyle(port);
	const pidStyle = window.getComputedStyle(pid);
	const scopeStyle = window.getComputedStyle(scope);
	return {
		gap: rowStyle.gap,
		paddingLeft: rowStyle.paddingLeft,
		paddingRight: rowStyle.paddingRight,
		portWidth: portStyle.width,
		pidWidth: pidStyle.width,
		scopeWidth: scopeStyle.width,
		scopeFlexShrink: scopeStyle.flexShrink,
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
				portWidth: '50px',
				pidWidth: '48px',
				scopeWidth: '56px',
				scopeFlexShrink: '0',
			});
			// 列の見出しは行の列と揃い、見出しの文字と矢印は列の幅に収まる
			const rowRect = (selector: string) => fixture.root.querySelector<HTMLElement>(`.ppl-row ${selector}`)!.getBoundingClientRect();
			const columns = ['port', 'process', 'scope', 'pid'].map(key => fixture.root.querySelector<HTMLElement>(`.ppl-col-${key}`)!);
			const [portColumn, , scopeColumn, pidColumn] = columns.map(column => column.getBoundingClientRect());
			assert.deepStrictEqual({
				port: [portColumn.left, portColumn.right],
				scope: [scopeColumn.left, scopeColumn.right],
				pid: [pidColumn.left, pidColumn.right],
				overflowing: columns.filter(column => column.scrollWidth > column.clientWidth).map(column => column.className),
			}, {
				port: [rowRect('.ppl-port').left, rowRect('.ppl-port').right],
				scope: [rowRect('.ppl-scope').left, rowRect('.ppl-scope').right],
				pid: [rowRect('.ppl-pid').left, rowRect('.ppl-pid').right],
				overflowing: [],
			});
			const chip = fixture.root.querySelector<HTMLElement>('.ppl-row .ppl-scope .paradis-chip')!.getBoundingClientRect();
			assert.ok(chip.left >= rowRect('.ppl-scope').left && chip.right <= rowRect('.ppl-scope').right);
			assert.strictEqual(killButton.getAttribute('aria-label'), 'PID 4321 を終了');
			assert.strictEqual(killButton.tabIndex, 0);
			killButton.focus();
			assert.strictEqual(document.activeElement, killButton);
			killButton.click();
			// 押すと行の中の確認に替わる。確認も枠の中に収まり、「終了」で止まる
			const confirmKill = fixture.root.querySelector<HTMLButtonElement>('.ppl-confirm .paradis-button-danger')!;
			const confirmRect = fixture.root.querySelector<HTMLElement>('.ppl-confirm')!.getBoundingClientRect();
			assert.ok(confirmRect.left >= panelRect.left && confirmRect.right <= panelRect.right);
			assert.deepStrictEqual(fixture.killedEntries, []);
			confirmKill.click();
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

	test('keeps the focus on the kill button of the same row when the list is refreshed', () => {
		const fixture = createPanelFixture();
		try {
			const otherEntry: IParadisPortEntry = { port: 3000, proto: 'TCP', pid: 99, processName: 'node', address: '127.0.0.1:3000', risky: false };
			fixture.panel.updateSnapshot({ entries: [otherEntry, longRiskyEntry], collectedAt: 1 });
			fixture.root.querySelectorAll<HTMLButtonElement>('.ppl-kill-btn')[1].focus();

			fixture.panel.updateSnapshot({ entries: [otherEntry, longRiskyEntry], collectedAt: 2 });
			const keptOnRow = document.activeElement?.getAttribute('aria-label');
			const keptIsNewButton = document.activeElement === fixture.root.querySelectorAll('.ppl-kill-btn')[1];

			fixture.panel.updateSnapshot({ entries: [otherEntry], collectedAt: 3 });
			const afterRowGone = document.activeElement === fixture.root.querySelector('.paradis-port-list-panel');

			assert.deepStrictEqual({ keptOnRow, keptIsNewButton, afterRowGone }, { keptOnRow: 'PID 4321 を終了', keptIsNewButton: true, afterRowGone: true });
		} finally {
			fixture.dispose();
		}
	});

	test('asks inside the row before killing, and Esc only cancels the question', () => {
		const fixture = createPanelFixture();
		try {
			const otherEntry: IParadisPortEntry = { port: 3000, proto: 'TCP', pid: 99, processName: 'node', address: '127.0.0.1:3000', risky: false };
			fixture.panel.updateSnapshot({ entries: [otherEntry, longRiskyEntry], collectedAt: 1 });
			const panel = fixture.root.querySelector<HTMLElement>('.paradis-port-list-panel')!;
			const escape = () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			fixture.root.querySelectorAll<HTMLButtonElement>('.ppl-kill-btn')[0].click();
			const asked = fixture.root.querySelector('.ppl-confirm-text')?.textContent;
			const focusOnCancel = document.activeElement?.textContent;
			// 確認中に一覧が描き直されても、確認とフォーカスは残る
			fixture.panel.updateSnapshot({ entries: [otherEntry, longRiskyEntry], collectedAt: 2 });
			const keptAfterRefresh = { asked: fixture.root.querySelectorAll('.ppl-confirm').length, focus: document.activeElement?.textContent };
			escape();
			const afterEscape = { confirms: fixture.root.querySelectorAll('.ppl-confirm').length, focus: document.activeElement?.getAttribute('aria-label'), closes: [...fixture.closes] };
			escape();
			assert.deepStrictEqual({ asked, focusOnCancel, keptAfterRefresh, afterEscape, closes: fixture.closes, killed: fixture.killedEntries }, {
				asked: 'PID 99 を終了しますか？',
				focusOnCancel: 'やめる',
				keptAfterRefresh: { asked: 1, focus: 'やめる' },
				afterEscape: { confirms: 0, focus: 'PID 99 を終了', closes: [] },
				closes: [true],
				killed: [],
			});
		} finally {
			fixture.dispose();
		}
	});

	test('shows the visible count over the total while filtering', () => {
		const fixture = createPanelFixture();
		try {
			const otherEntry: IParadisPortEntry = { port: 3000, proto: 'TCP', pid: 99, processName: 'node', address: '127.0.0.1:3000', risky: false };
			fixture.panel.updateSnapshot({ entries: [otherEntry, longRiskyEntry], collectedAt: 1 });
			const count = () => fixture.root.querySelector('.ppl-count')?.textContent;
			const all = count();
			fixture.root.querySelectorAll<HTMLButtonElement>('.ppl-chip')[1].click();
			const risky = count();
			assert.deepStrictEqual({ all, risky }, { all: '2', risky: '1 / 2' });
		} finally {
			fixture.dispose();
		}
	});

	test('marks a port open to every address with one text chip and nothing else', () => {
		const fixture = createPanelFixture();
		try {
			const otherEntry: IParadisPortEntry = { port: 3000, proto: 'TCP', pid: 99, processName: 'node', address: '127.0.0.1', risky: false };
			fixture.panel.updateSnapshot({ entries: [otherEntry, longRiskyEntry], collectedAt: 1 });
			const rows = [...fixture.root.querySelectorAll<HTMLElement>('.ppl-row')];
			assert.deepStrictEqual({
				rows: rows.map(row => ({ port: row.querySelector('.ppl-port')?.textContent, scope: row.querySelector('.ppl-scope')?.textContent, className: row.className })),
				dots: fixture.root.querySelectorAll('.ppl-dot').length,
				chipClass: fixture.root.querySelector('.ppl-scope .paradis-chip')?.className,
			}, {
				rows: [{ port: ':3000', scope: '', className: 'ppl-row' }, { port: ':65535', scope: '全公開', className: 'ppl-row' }],
				dots: 0,
				chipClass: 'paradis-chip paradis-chip-warning',
			});
		} finally {
			fixture.dispose();
		}
	});

	test('sorts by the pressed column, flips on the second press and remembers the choice', () => {
		const storage = new InMemoryStorageService();
		const entries: IParadisPortEntry[] = [
			{ port: 8080, proto: 'TCP', pid: 30, processName: 'beta', address: '127.0.0.1', risky: false },
			{ port: 3000, proto: 'TCP', pid: 99, processName: 'alpha', address: '*', risky: true },
			{ port: 5432, proto: 'TCP', pid: 10, processName: 'gamma', address: '127.0.0.1', risky: false },
		];
		const ports = (fixture: IPanelFixture) => [...fixture.root.querySelectorAll('.ppl-port')].map(port => port.textContent);
		const column = (fixture: IPanelFixture, key: string) => fixture.root.querySelector<HTMLButtonElement>(`.ppl-col-${key}`)!;
		const first = createPanelFixture(storage);
		let second: IPanelFixture | undefined;
		try {
			first.panel.updateSnapshot({ entries, collectedAt: 1 });
			const byDefault = ports(first);
			column(first, 'pid').click();
			const byPid = ports(first);
			column(first, 'pid').click();
			const byPidDescending = ports(first);
			column(first, 'scope').click();
			const byScope = ports(first);
			column(first, 'process').click();
			column(first, 'process').click();
			const byProcessDescending = ports(first);
			first.dispose();

			second = createPanelFixture(storage);
			second.panel.updateSnapshot({ entries, collectedAt: 2 });
			assert.deepStrictEqual({
				byDefault, byPid, byPidDescending, byScope, byProcessDescending,
				stored: storage.get('paradis.portList.view', StorageScope.APPLICATION),
				reopened: ports(second),
				reopenedColumns: ['port', 'process', 'scope', 'pid'].map(key => `${column(second!, key).className.includes(' on') ? 'on' : 'off'}: ${column(second!, key).getAttribute('aria-label')}`),
				arrow: column(second, 'process').querySelector('.ppl-col-arrow')?.className,
			}, {
				byDefault: [':3000', ':5432', ':8080'],
				byPid: [':5432', ':8080', ':3000'],
				byPidDescending: [':3000', ':8080', ':5432'],
				byScope: [':3000', ':5432', ':8080'],
				byProcessDescending: [':5432', ':8080', ':3000'],
				stored: '{"sortKey":"process","sortDirection":"desc","grouped":false}',
				reopened: [':5432', ':8080', ':3000'],
				reopenedColumns: [
					'off: ポートで並べ替え',
					'on: プロセスの降順で並べています。押すと昇順にします',
					'off: 公開の範囲で並べ替え',
					'off: PIDで並べ替え',
				],
				arrow: 'ppl-col-arrow codicon codicon-arrow-down',
			});
		} finally {
			first.dispose();
			second?.dispose();
			storage.dispose();
		}
	});

	test('folds the rows of one process under a heading, and Kill All still covers the folded rows', () => {
		const fixture = createPanelFixture();
		try {
			const entries: IParadisPortEntry[] = [
				{ port: 9229, proto: 'TCP', pid: 12, processName: 'node', address: '*', risky: true },
				{ port: 5432, proto: 'TCP', pid: 10, processName: 'postgres', address: '127.0.0.1', risky: false },
				{ port: 3000, proto: 'TCP', pid: 11, processName: 'node', address: '127.0.0.1', risky: false },
				{ port: 3001, proto: 'TCP', pid: 11, processName: 'node', address: '127.0.0.1', risky: false },
			];
			fixture.panel.updateSnapshot({ entries, collectedAt: 1 });
			const groupChip = fixture.root.querySelector<HTMLButtonElement>('.ppl-group-toggle')!;
			const heading = () => fixture.root.querySelector<HTMLButtonElement>('.ppl-group')!;
			const list = () => [...fixture.root.querySelectorAll<HTMLElement>('.ppl-list > *')].map(item => item.classList.contains('ppl-group')
				? `group ${item.querySelector('.ppl-proc')?.textContent} ${item.querySelector('.ppl-pid')?.textContent} ${item.querySelector('.ppl-scope')?.textContent} expanded=${item.getAttribute('aria-expanded')}`
				: `${item.className} ${item.querySelector('.ppl-port')?.textContent}`);
			groupChip.click();
			const folded = { pressed: groupChip.getAttribute('aria-pressed'), list: list(), count: fixture.root.querySelector('.ppl-count')?.textContent };
			fixture.root.querySelector<HTMLButtonElement>('.ppl-fbtn.danger')!.click();
			heading().focus();
			heading().click();
			const opened = { list: list(), focusOnHeading: document.activeElement === heading() };
			// 開いた中の行で確認を出したまま見出しを押すと（マウスは mousedown の後に click）、確認をやめて畳む
			fixture.root.querySelector<HTMLButtonElement>('.ppl-row.child .ppl-kill-btn')!.click();
			const asking = fixture.root.querySelectorAll('.ppl-confirm').length;
			const pressed = heading();
			pressed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
			const headingKeptForClick = pressed.isConnected;
			pressed.click();
			const foldedAgain = { list: list(), confirms: fixture.root.querySelectorAll('.ppl-confirm').length, focusOnHeading: document.activeElement === heading() };
			// 検索中は一致した行を隠さない
			const search = fixture.root.querySelector<HTMLInputElement>('.ppl-search-box input')!;
			search.value = 'node';
			search.dispatchEvent(new Event('input'));
			const searching = list();
			assert.deepStrictEqual({ folded, killAll: fixture.killAllRequests.map(request => request.map(entry => entry.port)), opened, asking, headingKeptForClick, foldedAgain, searching }, {
				folded: { pressed: 'true', list: ['group node 3 件 全公開 expanded=false', 'ppl-row :5432'], count: '4' },
				killAll: [[3000, 3001, 5432, 9229]],
				opened: { list: ['group node 3 件 全公開 expanded=true', 'ppl-row child :3000', 'ppl-row child :3001', 'ppl-row child :9229', 'ppl-row :5432'], focusOnHeading: true },
				asking: 1,
				headingKeptForClick: true,
				foldedAgain: { list: ['group node 3 件 全公開 expanded=false', 'ppl-row :5432'], confirms: 0, focusOnHeading: true },
				searching: ['group node 3 件 全公開 expanded=true', 'ppl-row child :3000', 'ppl-row child :3001', 'ppl-row child :9229'],
			});
		} finally {
			fixture.dispose();
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
