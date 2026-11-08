/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisSimulatorDisplayGeometry, paradisSimulatorFitSize, paradisSimulatorHidUsage, paradisSimulatorNextOrientation, paradisSimulatorPointFromClient, paradisSimulatorRawPoint, paradisSimulatorShouldSendKey, paradisSimulatorTouchEdge } from '../../common/paradisSimulatorInput.js';

suite('Paradis simulator: human input', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fits the frame into the area and maps pointer positions to 0..1', () => {
		const rect = { left: 100, top: 50, width: 200, height: 400 };
		assert.deepStrictEqual({
			tall: paradisSimulatorFitSize({ width: 800, height: 600 }, { width: 1206, height: 2622 }),
			wide: paradisSimulatorFitSize({ width: 800, height: 600 }, { width: 2622, height: 1206 }),
			unknown: paradisSimulatorFitSize({ width: 800, height: 600 }, { width: 0, height: 0 }),
			centre: paradisSimulatorPointFromClient(rect, 200, 250),
			corner: paradisSimulatorPointFromClient(rect, 100, 50),
			outside: paradisSimulatorPointFromClient(rect, 0, 1000),
			empty: paradisSimulatorPointFromClient({ left: 0, top: 0, width: 0, height: 0 }, 1, 1),
		}, {
			tall: { width: 275, height: 600 },
			wide: { width: 800, height: 367 },
			unknown: { width: 0, height: 0 },
			centre: { x: 0.5, y: 0.5 },
			corner: { x: 0, y: 0 },
			outside: { x: 0, y: 1 },
			empty: undefined,
		});
	});

	test('rotates clockwise through the four orientations', () => {
		assert.deepStrictEqual(['portrait', 'landscape_right', 'portrait_upside_down', 'landscape_left', 'sideways', undefined].map(paradisSimulatorNextOrientation),
			['landscape_right', 'portrait_upside_down', 'landscape_left', 'portrait', 'portrait', 'portrait']);
	});

	// Command・Control 付きは Para Code のショートカットに残す。IME の変換中も送らない
	test('maps keys to HID usages and keeps shortcuts for Para Code', () => {
		const key = (code: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; isComposing: boolean }> = {}) => paradisSimulatorShouldSendKey({ code, metaKey: false, ctrlKey: false, isComposing: false, ...extra });
		assert.deepStrictEqual({
			usages: ['KeyA', 'KeyZ', 'Digit1', 'Digit0', 'Enter', 'Backspace', 'Space', 'ArrowUp', 'ShiftLeft', 'F13'].map(paradisSimulatorHidUsage),
			send: [key('KeyA'), key('KeyW', { metaKey: true }), key('KeyC', { ctrlKey: true }), key('KeyA', { isComposing: true }), key('F13')],
		}, {
			usages: [0x04, 0x1d, 0x1e, 0x27, 0x28, 0x2a, 0x2c, 0x52, 0xe1, undefined],
			send: [true, false, false, false, false],
		});
	});

	// serve-sim の参照のクライアント（src/client/simulator/orientation.ts）と同じ: 生の映像が縦のまま横に回したときと 180° だけ CSS で回し、
	// 入力は回した分を戻す。下端で始まるドラッグには、向きに合わせたホームの端の印を付ける
	test('rotates the picture like the serve-sim client and maps taps and the home edge back to the device', () => {
		const portraitRaw = { width: 1206, height: 2622 };
		assert.deepStrictEqual({
			portrait: paradisSimulatorDisplayGeometry({ ...portraitRaw, orientation: 'portrait' }),
			leftRawPortrait: paradisSimulatorDisplayGeometry({ ...portraitRaw, orientation: 'landscape_left' }),
			leftRawLandscape: paradisSimulatorDisplayGeometry({ width: 2622, height: 1206, orientation: 'landscape_left' }),
			upsideDown: paradisSimulatorDisplayGeometry({ ...portraitRaw, orientation: 'portrait_upside_down' }),
			points: [
				paradisSimulatorRawPoint(undefined, 0.2, 0.3),
				paradisSimulatorRawPoint('landscape_left', 0.2, 0.3),
				paradisSimulatorRawPoint('landscape_right', 0.2, 0.3),
				paradisSimulatorRawPoint('portrait_upside_down', 0.2, 0.3),
			],
			edges: [paradisSimulatorTouchEdge(undefined, 0.5), paradisSimulatorTouchEdge(undefined, 0.95), paradisSimulatorTouchEdge('landscape_left', 0.95), paradisSimulatorTouchEdge('landscape_right', 0.95), paradisSimulatorTouchEdge('portrait_upside_down', 0.95)],
		}, {
			portrait: { display: { width: 1206, height: 2622 }, rotationDegrees: 0, inputOrientation: undefined },
			leftRawPortrait: { display: { width: 2622, height: 1206 }, rotationDegrees: 90, inputOrientation: 'landscape_left' },
			leftRawLandscape: { display: { width: 2622, height: 1206 }, rotationDegrees: 0, inputOrientation: undefined },
			upsideDown: { display: { width: 1206, height: 2622 }, rotationDegrees: 180, inputOrientation: 'portrait_upside_down' },
			points: [{ x: 0.2, y: 0.3 }, { x: 0.3, y: 0.8 }, { x: 0.7, y: 0.2 }, { x: 0.8, y: 0.7 }],
			edges: [0, 3, 4, 1, 2],
		});
	});
});
