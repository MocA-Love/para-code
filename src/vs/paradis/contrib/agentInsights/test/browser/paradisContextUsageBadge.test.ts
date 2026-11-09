/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createParadisContextUsageBadge, IParadisContextUsageReading, paradisContextUsagePopoverSize, paradisContextUsageSeverity } from '../../browser/paradisContextUsageBadge.js';

suite('ParadisContextUsageBadge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	test('turns yellow at 75% and red at 90%', () => {
		assert.deepStrictEqual([0, 74, 75, 89, 90, 100].map(paradisContextUsageSeverity), ['normal', 'normal', 'warning', 'warning', 'error', 'error']);
	});

	test('keeps the details popover inside the terminal: full size when wide, narrower and shorter when the terminal is small', () => {
		// 輪は右上（右端から 26px、上から 4px、幅 48px・高さ 16px）
		const terminal = (width: number, height: number) => ({ frame: { left: 100, right: 100 + width, bottom: 50 + height }, anchor: { left: 100 + width - 74, right: 100 + width - 26, bottom: 70 } });
		const size = (width: number, height: number) => { const { anchor, frame } = terminal(width, height); return paradisContextUsagePopoverSize(anchor, frame); };
		assert.deepStrictEqual([size(900, 800), size(260, 800), size(900, 200), size(120, 60)], [
			// 広いとき: 既定の 300px と 520px
			{ width: 300, maxHeight: 520 },
			// 狭いとき: 輪の右端からターミナルの左端までに収める（260 - 26 - 余白 4 - 外枠と左右の余白 18）
			{ width: 212, maxHeight: 520 },
			// 低いとき: 輪の下からターミナルの下端まで（250 - 70 - 余白 4 - 外枠・上下の余白・ポインタ 9）
			{ width: 300, maxHeight: 167 },
			// とても小さいとき: 幅は残りに合わせ、高さは最低限を残す
			{ width: 72, maxHeight: 60 },
		]);
	});

	test('shows the percentage of the current pane only, changes color with it, hides when gone and opens the details on click', () => {
		const onDidChange = store.add(new Emitter<void>());
		const readings = new Map<number, IParadisContextUsageReading>([[7, { percent: 24 }]]);
		const opened: number[] = [];
		const container = document.createElement('div');
		const badge = createParadisContextUsageBadge(container, {
			onDidChange: onDidChange.event,
			read: instanceId => readings.get(instanceId),
			tooltip: () => '',
			setupHover: () => Disposable.None,
			openDetails: (_element, instanceId) => opened.push(instanceId),
		});
		const element = container.firstElementChild as HTMLElement;
		const arc = element.querySelector('.arc')!;
		const snapshot = () => ({
			hidden: element.classList.contains('hidden'),
			warning: element.classList.contains('warning'),
			error: element.classList.contains('error'),
			text: element.textContent,
			// 輪の欠け（残り）の割合
			rest: element.classList.contains('hidden') ? undefined : Math.round(Number(arc.getAttribute('stroke-dashoffset')) / Number(arc.getAttribute('stroke-dasharray')) * 100),
		});
		try {
			const states = [snapshot()];
			badge.setInstance(7);
			states.push(snapshot());
			element.click();
			readings.set(7, { percent: 82 });
			onDidChange.fire();
			states.push(snapshot());
			readings.set(7, { percent: 93 });
			onDidChange.fire();
			states.push(snapshot());
			badge.setInstance(8);
			states.push(snapshot());
			element.click();
			assert.deepStrictEqual({ states, opened }, {
				states: [
					// 対象ペインが決まるまでは出さない
					{ hidden: true, warning: false, error: false, text: '', rest: undefined },
					{ hidden: false, warning: false, error: false, text: '24%', rest: 76 },
					{ hidden: false, warning: true, error: false, text: '82%', rest: 18 },
					{ hidden: false, warning: false, error: true, text: '93%', rest: 7 },
					// 値の無いペイン（シェルなど）では消え、押しても開かない
					{ hidden: true, warning: false, error: false, text: '', rest: undefined },
				],
				opened: [7],
			});
		} finally {
			badge.dispose();
		}
		assert.strictEqual(container.childElementCount, 0);
	});
});
