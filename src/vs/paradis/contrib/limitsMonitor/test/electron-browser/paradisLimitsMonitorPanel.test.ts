/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IParadisLimitsSnapshot } from '../../common/paradisLimitsMonitor.js';
import { ParadisLimitsMonitorClient } from '../../electron-browser/paradisLimitsMonitorClient.js';
import { ParadisLimitsMonitorPanel } from '../../electron-browser/paradisLimitsMonitorPanel.js';

// 利用リミットのパネル（Q537 の 37 A・40 A）: 上端の見出しの行に題・時刻・22px のボタン、
// アカウントの追加はアイコンのボタン、残り時間は日本語の単位。

const HOUR = 60 * 60_000;

suite('ParadisLimitsMonitorPanel', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('puts the title, the time and the icon buttons in a header, and writes the time left in Japanese', () => {
		const root = document.createElement('div');
		document.body.appendChild(root);
		try {
			const now = Date.now();
			const snapshot: IParadisLimitsSnapshot = {
				fetchedAt: now,
				claude: {
					accounts: [{
						provider: 'claude', id: 'para-claude:1', email: 'work@example.com', active: true, managed: true, status: 'ok', fetchedAt: now,
						fiveHour: { usedPercent: 42, resetsAt: now + 2 * HOUR + 13 * 60_000 },
						sevenDay: { usedPercent: 31, resetsAt: now + 4 * 24 * HOUR + 6 * HOUR },
					}],
				},
				codex: { accounts: [] },
			};
			const instantiationService = store.add(new TestInstantiationService());
			instantiationService.stub(ILayoutService, upcastPartial<ILayoutService>({ activeContainer: root }));
			instantiationService.stub(IHoverService, NullHoverService);
			instantiationService.stub(IContextMenuService, upcastPartial<IContextMenuService>({}));
			const anchor = document.createElement('button');
			root.appendChild(anchor);
			let masked = false;
			store.add(instantiationService.createInstance(ParadisLimitsMonitorPanel, anchor, {
				initialSnapshot: snapshot,
				client: upcastPartial<ParadisLimitsMonitorClient>({}),
				onManualRefresh: () => { },
				onClose: () => { },
				onAddAccount: () => { },
				onRelogin: () => { },
				onRemoveAccount: () => { },
				isAccountHidden: () => false,
				onToggleHiddenAccounts: () => { },
				displayName: account => account.email ?? account.id,
				displayNameForEmail: (_provider, email) => email,
				isEmailMasked: () => masked,
				onToggleEmailMask: () => { masked = !masked; },
				scheduleRetry: () => { },
				cancelRetry: () => { },
			}));

			const panel = root.querySelector('.paradis-limits-panel')!;
			const header = panel.querySelector('.plm-header')!;
			assert.deepStrictEqual({
				firstChild: panel.firstElementChild?.className,
				title: header.querySelector('.plm-title')?.textContent,
				headerButtons: [...header.querySelectorAll('button.plm-icon-btn')].map(button => button.getAttribute('aria-label')),
				footer: !!panel.querySelector('.plm-footer'),
				addButtons: [...panel.querySelectorAll('.plm-provider-header button.plm-add-btn')].map(button => button.getAttribute('aria-label')),
				resets: [...panel.querySelectorAll('.plm-meter-reset')].map(cell => cell.textContent),
				// 「…」はカードの最後（Tab でカードのボタンの後）にあり、隠していてもフォーカスを受けられる。
				menuIsLastInCard: panel.querySelector('.plm-account')?.lastElementChild?.classList.contains('plm-account-menu'),
				menuFocusable: (() => { const menu = panel.querySelector<HTMLButtonElement>('.plm-account-menu'); menu?.focus(); return document.activeElement === menu; })(),
			}, {
				firstChild: 'plm-header',
				title: 'AI 利用リミット',
				headerButtons: ['更新', 'メールを番号に'],
				footer: false,
				addButtons: ['Claude のアカウントを追加', 'Codex のアカウントを追加'],
				resets: ['2時間13分後', '4日6時間後'],
				menuIsLastInCard: true,
				menuFocusable: true,
			});
		} finally {
			root.remove();
		}
	});
});
