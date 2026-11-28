/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { renderParadisBotFace } from '../../browser/paradisBotFace.js';

suite('Paradis bot face', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function look(face: HTMLElement) {
		return {
			state: face.dataset.state,
			props: face.dataset.props,
			still: face.dataset.still,
			transition: face.dataset.transition,
			clock: face.style.getPropertyValue('--paradis-bot-face-loop') !== '',
			since: face.style.getPropertyValue('--paradis-bot-face-since') !== '',
			// 止めた表示でも様子を読ませる部品（目の形と印）がそろっている
			parts: ['eyes-open', 'eyes-closed', 'eyes-flat', 'eyes-happy', 'dots', 'lens', 'zz', 'pause', 'ask', 'sweat', 'check'].filter(part => face.getElementsByClassName(`paradis-bot-face-${part}`).length === 0),
		};
	}

	test('見本は動かさず、小道具の既定は注意の要る 2 つだけ。様子が変わった最初の描画だけ、つなぎを付ける', () => {
		const parent = mainWindow.document.createElement('div');
		const swatch = renderParadisBotFace(parent, { shape: 'circle', color: 'red', still: true });
		const preview = renderParadisBotFace(parent, { shape: 'blob', color: 'amber', props: 'none' });
		const first = renderParadisBotFace(parent, { shape: 'hex', color: 'blue', state: 'work', id: 'paradis-bot-face-test' });
		const done = renderParadisBotFace(parent, { shape: 'hex', color: 'blue', state: 'idle', id: 'paradis-bot-face-test', props: 'all' });
		const redrawn = renderParadisBotFace(parent, { shape: 'hex', color: 'blue', state: 'idle', id: 'paradis-bot-face-test' });
		assert.deepStrictEqual([swatch, preview, first, done, redrawn].map(look), [
			{ state: 'idle', props: 'attention', still: 'true', transition: undefined, clock: false, since: false, parts: [] },
			{ state: 'idle', props: 'none', still: undefined, transition: undefined, clock: true, since: false, parts: [] },
			{ state: 'work', props: 'attention', still: undefined, transition: undefined, clock: true, since: false, parts: [] },
			{ state: 'idle', props: 'all', still: undefined, transition: 'done', clock: true, since: true, parts: [] },
			// 描き直しても同じつなぎの続き（経った時間だけ進む）
			{ state: 'idle', props: 'attention', still: undefined, transition: 'done', clock: true, since: true, parts: [] },
		]);
	});
});
