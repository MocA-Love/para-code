/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisFindHighlightScript, paradisReadViewerScrollState, paradisScrollRestoreScript } from '../../common/paradisViewerScroll.js';

suite('ParadisViewerScroll', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('only a finite, non-negative progress is read back as view state', () => {
		assert.deepStrictEqual([
			paradisReadViewerScrollState({ scrollProgress: 0.4 }),
			paradisReadViewerScrollState({ scrollProgress: -1 }),
			paradisReadViewerScrollState({ scrollProgress: Number.NaN }),
			paradisReadViewerScrollState({ scrollProgress: '0.4' }),
			paradisReadViewerScrollState({ cursorState: [] }),
			paradisReadViewerScrollState(undefined),
		], [
			{ scrollProgress: 0.4 },
			{ scrollProgress: 0 },
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('the restore script embeds a sanitized number and the nonce', () => {
		const withNonce = paradisScrollRestoreScript(1.5, 'abc');
		const invalid = paradisScrollRestoreScript(Number.POSITIVE_INFINITY);
		assert.deepStrictEqual({
			nonce: withNonce.startsWith('<script nonce="abc">'),
			progress: withNonce.includes('var p=1.5;'),
			noNonce: invalid.startsWith('<script>'),
			fallback: invalid.includes('var p=0;'),
		}, {
			nonce: true,
			progress: true,
			noNonce: true,
			fallback: true,
		});
	});

	test('the restore script moves the window and stops once the user scrolls', () => {
		const calls: number[] = [];
		const listeners = new Map<string, () => void>();
		const fakeWindow = {
			scrollX: 0,
			scrollTo: (_x: number, y: number) => calls.push(y),
			addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
		};
		const timeouts: Array<() => void> = [];
		const body = paradisScrollRestoreScript(0.5).replace(/^<script>/, '').replace(/<\/script>$/, '');
		new Function('window', 'document', 'setTimeout', body)(fakeWindow, { body: { clientHeight: 1000 } }, (fn: () => void) => timeouts.push(fn));

		listeners.get('load')!();
		timeouts.splice(0).forEach(fn => fn());
		listeners.get('wheel')!();
		listeners.get('load')!();
		timeouts.splice(0).forEach(fn => fn());

		assert.deepStrictEqual(calls, [500, 500]);
	});

	test('the find highlight is only applied while the page has no focus', () => {
		let focused = false;
		const listeners = new Map<string, () => void>();
		const head = { children: [] as unknown[], appendChild(child: unknown) { this.children.push(child); } };
		const style = {
			attributes: new Map<string, string>(),
			textContent: '',
			get parentNode() { return head.children.includes(style) ? { removeChild: (child: unknown) => head.children.splice(head.children.indexOf(child), 1) } : null; },
			setAttribute(name: string, value: string) { this.attributes.set(name, value); },
		};
		const fakeDocument = { head, hasFocus: () => focused, createElement: () => style };
		const fakeWindow = { addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) };
		const body = paradisFindHighlightScript('n1').replace(/^<script nonce="n1">/, '').replace(/<\/script>$/, '');
		new Function('window', 'document', body)(fakeWindow, fakeDocument);

		const states = [head.children.length];
		focused = true;
		listeners.get('focus')!();
		states.push(head.children.length);
		focused = false;
		listeners.get('blur')!();
		states.push(head.children.length);

		assert.deepStrictEqual({ states, nonce: style.attributes.get('nonce'), selection: style.textContent.startsWith('::selection{') }, { states: [1, 0, 1], nonce: 'n1', selection: true });
	});
});
