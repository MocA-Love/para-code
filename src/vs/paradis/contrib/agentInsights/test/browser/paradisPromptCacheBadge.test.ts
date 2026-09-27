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
import { createParadisPromptCacheBadge, setParadisPromptCacheBadgeHost } from '../../browser/paradisPromptCacheBadge.js';
import { IParadisPromptCacheReading } from '../../browser/paradisPromptCacheClock.js';

suite('ParadisPromptCacheBadge', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => setParadisPromptCacheBadgeHost(undefined));

	test('shows the countdown for the current pane only, turns yellow near the end and hides when gone', () => {
		const onDidChange = store.add(new Emitter<void>());
		const readings = new Map<number, IParadisPromptCacheReading>([[7, { remainingMs: 252_000, ttlMs: 300_000, warning: false }]]);
		setParadisPromptCacheBadgeHost({
			onDidChange: onDidChange.event,
			read: instanceId => readings.get(instanceId),
			setupHover: () => Disposable.None,
		});
		const container = document.createElement('div');
		const badge = createParadisPromptCacheBadge(container);
		const element = container.firstElementChild as HTMLElement;
		const snapshot = () => ({ hidden: element.classList.contains('hidden'), warning: element.classList.contains('warning'), text: element.textContent });
		try {
			const states = [snapshot()];
			badge.setInstance(7);
			states.push(snapshot());
			readings.set(7, { remainingMs: 48_000, ttlMs: 300_000, warning: true });
			onDidChange.fire();
			states.push(snapshot());
			readings.delete(7);
			onDidChange.fire();
			states.push(snapshot());
			assert.deepStrictEqual(states, [
				// 対象ペインが決まるまでは出さない
				{ hidden: true, warning: false, text: '' },
				{ hidden: false, warning: false, text: '4:12' },
				{ hidden: false, warning: true, text: '0:48' },
				// 切れたら消す
				{ hidden: true, warning: false, text: '' },
			]);
		} finally {
			badge.dispose();
		}
		assert.strictEqual(container.childElementCount, 0);
	});
});
