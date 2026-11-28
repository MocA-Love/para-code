/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { Event } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { MockContextKeyService } from '../../../../../platform/keybinding/test/common/mockKeybindingService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { AccessibilityService } from '../../../../../platform/accessibility/browser/accessibilityService.js';
import { renderParadisBotFace } from '../../browser/paradisBotFace.js';
import { ParadisBotFaceState } from '../../common/paradisBotsBandModel.js';

suite('Paradis bot face', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

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

	/**
	 * 動きを止めた表示で、帯の 18px の顔が目の形と印だけで見分けられるか。止めるかは本物の AccessibilityService が決める
	 * （`workbench.reduceMotion` の on・off と、auto のときは OS の `prefers-reduced-motion` を matchMedia で読む）。
	 */
	function readRow(reduceMotion: 'on' | 'off' | 'auto') {
		const instantiation = store.add(new TestInstantiationService());
		instantiation.stub(IConfigurationService, new TestConfigurationService({ 'workbench.reduceMotion': reduceMotion, 'workbench.reduceTransparency': 'off', 'editor.accessibilitySupport': 'off', 'accessibility.underlineLinks': false }));
		instantiation.stub(IContextKeyService, store.add(new MockContextKeyService()));
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		instantiation.stub(ILayoutService, { mainContainer: container, activeContainer: container, containers: [container], getContainer: () => container, onDidAddContainer: Event.None, onDidLayoutContainer: Event.None });
		store.add(instantiation.createInstance(AccessibilityService));
		const states: ParadisBotFaceState[] = ['idle', 'work', 'patrol', 'ask', 'need', 'halt', 'sleep', 'off', 'paused'];
		const row = states.map(state => {
			const face = renderParadisBotFace(container, { shape: 'circle', color: 'blue', state, id: `paradis-bot-face-row-${state}` });
			const shown = [...face.getElementsByClassName('paradis-bot-face-prop')].filter(prop => mainWindow.getComputedStyle(prop).display !== 'none').map(prop => prop.getAttribute('class')!.replace('paradis-bot-face-prop paradis-bot-face-', ''));
			const eye = face.getElementsByClassName('paradis-bot-face-eye')[0];
			return `${state}:${shown.join('+') || '-'}${mainWindow.getComputedStyle(eye).animationName === 'none' ? '' : '~'}`;
		});
		const reduced = container.classList.contains('monaco-reduce-motion');
		container.remove();
		return { reduced, row };
	}

	test('動きを止めた表示では、18px の顔にも様子の印を足す（設定の on と、auto で OS の設定に従う経路）', () => {
		const os = mainWindow.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const still = ['idle:-', 'work:dots', 'patrol:lens', 'ask:ask', 'need:sweat', 'halt:-', 'sleep:zz', 'off:-', 'paused:pause'];
		// 動いているときは、印は注意の 2 つだけ（目の動きで分かる）。止まっている様子（need・halt・off・paused）は元から瞬きしない
		const moving = ['idle:-~', 'work:-~', 'patrol:-~', 'ask:ask~', 'need:sweat', 'halt:-', 'sleep:-~', 'off:-~', 'paused:-'];
		assert.deepStrictEqual({ on: readRow('on'), off: readRow('off'), auto: readRow('auto') }, {
			on: { reduced: true, row: still },
			// off でも OS の設定が「減らす」なら、メディアクエリの方で止める
			off: { reduced: false, row: os ? still : moving },
			auto: { reduced: os, row: os ? still : moving },
		});
	});
});
