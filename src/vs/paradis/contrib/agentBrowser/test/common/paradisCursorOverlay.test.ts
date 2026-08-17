/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS,
	PARADIS_CURSOR_OVERLAY_TUNING,
	paradisBuildCursorOverlayScript,
	paradisClampCursorWaitMs,
	paradisCursorGlideMs,
	paradisCursorMoveMaxMs,
	paradisEncodeCursorOverlayPayload,
} from '../../common/paradisCursorOverlay.js';

suite('Paradis Cursor Overlay', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('wait time from the page is clamped to a safe range', () => {
		assert.deepStrictEqual(
			[
				paradisClampCursorWaitMs(250),
				paradisClampCursorWaitMs(250.4),
				paradisClampCursorWaitMs(0),
				paradisClampCursorWaitMs(-10),
				paradisClampCursorWaitMs(Number.NaN),
				paradisClampCursorWaitMs(Number.POSITIVE_INFINITY),
				paradisClampCursorWaitMs('250'),
				paradisClampCursorWaitMs(undefined),
				paradisClampCursorWaitMs(null),
				paradisClampCursorWaitMs(10_000),
				paradisClampCursorWaitMs(300, 120),
			],
			[250, 250, 0, 0, 0, 0, 0, 0, 0, PARADIS_CURSOR_OVERLAY_MAX_WAIT_MS, 120],
		);
	});

	test('dragging moves are capped much shorter than free moves', () => {
		assert.deepStrictEqual(
			[
				paradisCursorMoveMaxMs({ type: 'mouseMoved', x: 1, y: 2 }),
				paradisCursorMoveMaxMs({ type: 'mouseMoved', x: 1, y: 2, buttons: 0 }),
				paradisCursorMoveMaxMs({ type: 'mouseMoved', x: 1, y: 2, buttons: 1 }),
				paradisCursorMoveMaxMs({ type: 'mouseMoved', x: 1, y: 2, buttons: 'left' }),
			],
			[
				PARADIS_CURSOR_OVERLAY_TUNING.maxMs,
				PARADIS_CURSOR_OVERLAY_TUNING.maxMs,
				PARADIS_CURSOR_OVERLAY_TUNING.dragMaxMs,
				PARADIS_CURSOR_OVERLAY_TUNING.maxMs,
			],
		);
	});

	test('glide length comes from distance, bounded by the tuning and the per-event cap', () => {
		const T = PARADIS_CURSOR_OVERLAY_TUNING;
		const at = 1_000;
		assert.deepStrictEqual(
			[
				// No previous position: fade in rather than glide from nowhere.
				paradisCursorGlideMs(undefined, { x: 100, y: 100, at }, T.maxMs),
				// Older than the page's own idle expiry: the cursor is gone, so fade in again.
				paradisCursorGlideMs({ x: 0, y: 0, at: at - T.idleMs - 1 }, { x: 900, y: 0, at }, T.maxMs),
				// Below the snap threshold: no animation at all.
				paradisCursorGlideMs({ x: 0, y: 0, at }, { x: T.snapPx - 1, y: 0, at }, T.maxMs),
				// 440px at 2.2px/ms.
				paradisCursorGlideMs({ x: 0, y: 0, at }, { x: 440, y: 0, at }, T.maxMs),
				// Short hops still take the minimum so they read as movement.
				paradisCursorGlideMs({ x: 0, y: 0, at }, { x: 20, y: 0, at }, T.maxMs),
				// Long hauls are capped.
				paradisCursorGlideMs({ x: 0, y: 0, at }, { x: 100_000, y: 0, at }, T.maxMs),
				// Dragging uses the shorter cap.
				paradisCursorGlideMs({ x: 0, y: 0, at }, { x: 100_000, y: 0, at }, T.dragMaxMs),
			],
			[T.appearMs, T.appearMs, 0, 200, T.minMs, T.maxMs, T.dragMaxMs],
		);
	});

	test('payload carries the tuning plus the command, with line separators escaped', () => {
		const payload = paradisEncodeCursorOverlayPayload(
			{ kind: 'move', x: 12, y: 34, label: 'a\u2028b\u2029c', durationMs: 200 },
			PARADIS_CURSOR_OVERLAY_TUNING,
		);
		assert.deepStrictEqual(
			{
				parsed: JSON.parse(payload),
				hasRawSeparators: /[\u2028\u2029]/.test(payload),
			},
			{
				parsed: { ...PARADIS_CURSOR_OVERLAY_TUNING, kind: 'move', x: 12, y: 34, label: 'a\u2028b\u2029c', durationMs: 200 },
				hasRawSeparators: false,
			},
		);
	});

	test('generated script is a self-contained expression that never uses HTML or CSS text sinks', () => {
		const script = paradisBuildCursorOverlayScript({ kind: 'move', x: 5, y: 6, label: 'エージェント', durationMs: 200 });
		assert.deepStrictEqual(
			{
				startsAsExpression: script.startsWith('(function (c) {'),
				endsWithPayloadCall: script.trimEnd().endsWith('})'),
				usesInnerHtml: script.includes('innerHTML'),
				usesOuterHtml: script.includes('outerHTML'),
				usesInsertAdjacentHtml: script.includes('insertAdjacentHTML'),
				usesStyleElement: script.includes('createElement(\'style\')'),
				usesEval: script.includes('eval('),
				carriesCoordinates: script.includes('"x":5') && script.includes('"y":6'),
			},
			{
				startsAsExpression: true,
				endsWithPayloadCall: true,
				usesInnerHtml: false,
				usesOuterHtml: false,
				usesInsertAdjacentHtml: false,
				usesStyleElement: false,
				usesEval: false,
				carriesCoordinates: true,
			},
		);
	});

	test('every command kind builds a syntactically valid script', () => {
		const kinds = [
			{ kind: 'move', x: 1, y: 2, label: 'x', durationMs: 200 },
			{ kind: 'press', x: 1, y: 2, label: 'x' },
			{ kind: 'focus', label: 'x' },
			{ kind: 'hide' },
			{ kind: 'show' },
			{ kind: 'captured', toast: 'done' },
			{ kind: 'remove' },
		] as const;
		assert.deepStrictEqual(
			kinds.map(command => {
				const script = paradisBuildCursorOverlayScript(command);
				try {
					// Parsing without running proves the generated text is a valid expression.
					new Function(`return ${script};`);
					return { kind: command.kind, valid: true };
				} catch {
					return { kind: command.kind, valid: false };
				}
			}),
			kinds.map(command => ({ kind: command.kind, valid: true })),
		);
	});
});
