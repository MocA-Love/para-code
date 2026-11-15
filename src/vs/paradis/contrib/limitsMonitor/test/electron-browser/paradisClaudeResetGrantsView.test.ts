/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFormatLimitsDateTime } from '../../common/paradisLimitsDates.js';
import { IParadisClaudeResetGrant, IParadisLimitsAccount } from '../../common/paradisLimitsMonitor.js';
import { paradisRenderClaudeResetGrants } from '../../electron-browser/paradisClaudeResetGrantsView.js';
import { IParadisLimitsPanelContext } from '../../electron-browser/paradisLimitsPanelContributions.js';

const DAY = 86_400_000;

suite('Paradis Claude limit resets on the limits panel', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function render(grants: readonly IParadisClaudeResetGrant[] | undefined, open: Set<string>, status: IParadisLimitsAccount['status'] = 'ok'): HTMLElement {
		const container = document.createElement('div');
		const context = upcastPartial<IParadisLimitsPanelContext>({ trackFocus: () => { }, redraw: () => { } });
		const store = disposables.add(new DisposableStore());
		paradisRenderClaudeResetGrants(container, store, { provider: 'claude', id: 'a', status, ...(grants ? { claudeResetGrants: grants } : {}) }, context, open);
		return container;
	}

	function describe(container: HTMLElement): object {
		return {
			line: container.querySelector('.plm-card-actions-start')?.textContent ?? undefined,
			soon: container.querySelector('.plm-card-actions-start')?.classList.contains('soon'),
			toggle: container.querySelector('button') !== null,
			buttons: container.querySelectorAll('button').length,
			rows: [...container.querySelectorAll('li')].map(item => item.textContent),
		};
	}

	// 使うボタンは置かない（ボタンは開閉の 1 つだけ）。期限は 7 日以内なら黄色、年が違えば年を出す。
	test('shows one line per account, the list when there are two or more bundles, and no button to use them', () => {
		const now = Date.now();
		const late = now + 114 * DAY;
		const soonEnd = now + 2 * DAY;
		const lateText = paradisFormatLimitsDateTime(late, now);
		const soonText = paradisFormatLimitsDateTime(soonEnd, now);
		assert.deepStrictEqual({
			two: describe(render([{ kind: 'fable', left: 2, endsAt: late }, { kind: 'full', left: 1 }], new Set(['a']))),
			closed: describe(render([{ kind: 'fable', left: 2, endsAt: late }, { kind: 'full', left: 1 }], new Set())),
			one: describe(render([{ kind: 'fable', left: 1, endsAt: soonEnd }], new Set())),
			none: describe(render([], new Set())),
			missing: describe(render(undefined, new Set())),
			notOk: describe(render([{ kind: 'full', left: 1 }], new Set(), 'error')),
		}, {
			two: { line: 'リミットリセット: Fable ×2・全部 ×1', soon: false, toggle: true, buttons: 1, rows: [`Fable リセット ×2${lateText} まで114日後`, '全部リセット ×1期限は不明', '使うときは claude.ai の設定の「使用量」から'] },
			closed: { line: 'リミットリセット: Fable ×2・全部 ×1', soon: false, toggle: true, buttons: 1, rows: [] },
			one: { line: `リミットリセット: Fable ×1 · ${soonText} に期限`, soon: true, toggle: false, buttons: 0, rows: [] },
			none: { line: undefined, soon: undefined, toggle: false, buttons: 0, rows: [] },
			missing: { line: undefined, soon: undefined, toggle: false, buttons: 0, rows: [] },
			notOk: { line: undefined, soon: undefined, toggle: false, buttons: 0, rows: [] },
		});
	});
});
