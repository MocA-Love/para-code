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
	paradisCursorCaptureRange,
	paradisCursorGlideMs,
	paradisCursorMoveMaxMs,
	paradisCursorKeyLabel,
	paradisCursorStatusForMirror,
	paradisEncodeCursorOverlayPayload,
	paradisIsStickyCursorStatus,
	paradisParseCursorStatusNote,
	paradisShouldShowCursorLook,
} from '../../common/paradisCursorOverlay.js';
import { PARADIS_CURSOR_REST_HEADING, paradisPlanCursorGlide, paradisSampleCursorGlide } from '../../common/paradisCursorMotion.js';

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
			{ kind: 'move', x: 12, y: 34, label: 'a\u2028b\u2029c', durationMs: 200, frames: [] },
			PARADIS_CURSOR_OVERLAY_TUNING,
		);
		assert.deepStrictEqual(
			{
				parsed: JSON.parse(payload),
				hasRawSeparators: /[\u2028\u2029]/.test(payload),
			},
			{
				parsed: { ...PARADIS_CURSOR_OVERLAY_TUNING, kind: 'move', x: 12, y: 34, label: 'a\u2028b\u2029c', durationMs: 200, frames: [] },
				hasRawSeparators: false,
			},
		);
	});

	test('generated script is a self-contained expression that never uses HTML or CSS text sinks', () => {
		const script = paradisBuildCursorOverlayScript({ kind: 'move', x: 5, y: 6, label: 'エージェント', durationMs: 200, frames: [{ x: 5, y: 6, r: 0, o: 1 }] });
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
			{ kind: 'move', x: 1, y: 2, label: 'x', durationMs: 200, frames: [{ x: 1, y: 2, r: 0, o: 1 }] },
			{ kind: 'press', x: 1, y: 2, label: 'x' },
			{ kind: 'release' },
			{ kind: 'focus', label: 'x', texts: { typing: 't', secret: 's', page: 'p' }, key: 'Enter' },
			{ kind: 'wheel', label: 'x', dx: 0, dy: 10, text: 's' },
			{ kind: 'status', label: 'x', status: 'failed', text: 'f', frames: [{ x: 1, y: 2, r: 0, o: 1 }], durationMs: 100 },
			{ kind: 'hide' },
			{ kind: 'show' },
			{ kind: 'captured', toast: 'done' },
			{ kind: 'captured', toast: 'done', rect: { x: 1, y: 2, width: 3, height: 4, doc: true } },
			{ kind: 'flash', toast: 'done', rect: { x: 1, y: 2, width: 3, height: 4 } },
			{ kind: 'status', label: 'x', status: 'reading', text: 'r', park: true, box: { x: 1, y: 2, width: 3, height: 4 }, transient: true },
			{ kind: 'status', label: 'x', status: 'script', text: 's', park: true, clickText: 'c' },
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

	test('key badges name special keys and shortcuts, never typed characters', () => {
		const key = (k: string, modifiers = 0, type = 'keyDown') => [paradisCursorKeyLabel({ type, key: k, modifiers }, true), paradisCursorKeyLabel({ type, key: k, modifiers }, false)];
		assert.deepStrictEqual(
			{ enter: key('Enter'), cmdK: key('k', 4), shiftTab: key('Tab', 8), letter: key('a'), shiftLetter: key('A', 8), up: key('Enter', 0, 'keyUp'), meta: key('Meta', 4), option: key('é', 1), altGr: key('@', 3), space: key(' ') },
			{ enter: ['Enter', 'Enter'], cmdK: ['\u2318K', 'Win+K'], shiftTab: ['\u21e7Tab', 'Shift+Tab'], letter: [undefined, undefined], shiftLetter: [undefined, undefined], up: [undefined, undefined], meta: [undefined, undefined], option: [undefined, undefined], altGr: [undefined, undefined], space: [undefined, undefined] },
		);
	});

	test('tool status notes from the shared process are checked before they reach the page', () => {
		assert.deepStrictEqual(
			[
				paradisParseCursorStatusNote({ status: 'select', detail: 'Card', point: { x: 10, y: 20 } }),
				paradisParseCursorStatusNote({ status: 'failed', point: { x: Number.NaN, y: 1 } }),
				paradisParseCursorStatusNote({ status: 'dance' }),
				paradisParseCursorStatusNote(null),
				paradisParseCursorStatusNote({ status: 'reading', rect: { x: -4, y: 20, width: 30, height: 8 }, flash: true }),
				paradisParseCursorStatusNote({ status: 'loading', rect: { x: 1, y: 2, width: -3, height: 4 }, flash: 'yes' }),
			],
			[
				{ status: 'select', detail: 'Card', point: { x: 10, y: 20 } }, { status: 'failed' }, undefined, undefined,
				{ status: 'reading', rect: { x: -4, y: 20, width: 30, height: 8 }, flash: true }, { status: 'loading' },
			],
		);
	});

	test('the reading frame skips the same element and anything within a second, and the states map for the mirror and the name tag', () => {
		const rect = { x: 10, y: 20, width: 100, height: 30 };
		const other = { x: 10, y: 80, width: 100, height: 30 };
		const shown = { key: '10,20,100,30', at: 1_000 };
		assert.deepStrictEqual(
			{
				first: paradisShouldShowCursorLook(undefined, rect, 1_000),
				sameLater: paradisShouldShowCursorLook(shown, rect, 9_000),
				otherSoon: paradisShouldShowCursorLook(shown, other, 1_500),
				otherLater: paradisShouldShowCursorLook(shown, other, 2_000),
				empty: paradisShouldShowCursorLook(undefined, { x: 0, y: 0, width: 0, height: 10 }, 1_000),
				sticky: (['script', 'waiting', 'loading', 'reading', 'scroll', 'failed', 'idle'] as const).filter(paradisIsStickyCursorStatus),
				mirror: (['loading', 'reading', 'script', 'idle'] as const).map(paradisCursorStatusForMirror),
				ranges: [
					paradisCursorCaptureRange(undefined),
					paradisCursorCaptureRange({ fullPage: true }),
					paradisCursorCaptureRange({ pageRect: { x: 1, y: 2, width: 3, height: 4 } }),
					paradisCursorCaptureRange({ pageRect: { x: 1, y: 2, width: 3, height: 4 }, captureBeyondViewport: true }),
				],
			},
			{
				first: true, sameLater: false, otherSoon: false, otherLater: true, empty: false,
				sticky: ['script', 'waiting', 'loading', 'reading'],
				mirror: ['waiting', undefined, 'script', 'idle'],
				ranges: [undefined, undefined, { x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4, doc: true }],
			},
		);
	});

	test('a planned glide arrives when the current formula says, then settles, and can be sampled midway', () => {
		const from = { x: 0, y: 0, heading: PARADIS_CURSOR_REST_HEADING };
		const glide = paradisPlanCursorGlide(from, { x: 440, y: 0 }, 200);
		const last = glide.frames[glide.frames.length - 1];
		const snap = paradisPlanCursorGlide(from, { x: 3, y: 0 }, 0);
		const drag = paradisPlanCursorGlide(from, { x: 90, y: 0 }, 90, { straight: true });
		const midway = paradisSampleCursorGlide(glide, glide.arrivalMs / 2);
		assert.deepStrictEqual(
			{
				arrivalMs: glide.arrivalMs,
				settlesAfterArrival: glide.durationMs >= glide.arrivalMs,
				framesBounded: glide.frames.length >= 2 && glide.frames.length <= 49,
				offsetsOrdered: glide.frames.every((frame, i) => i === 0 || frame.o >= glide.frames[i - 1].o),
				starts: { x: glide.frames[0].x, y: glide.frames[0].y, o: glide.frames[0].o },
				ends: { x: last.x, y: last.y, r: last.r, o: last.o },
				midwayBetween: midway.x > 0 && midway.x < 440,
				snap: { durationMs: snap.durationMs, frames: snap.frames.map(frame => [frame.x, frame.y]) },
				drag: { durationMs: drag.durationMs, frames: drag.frames.map(frame => [frame.x, frame.y, frame.o]) },
			},
			{
				arrivalMs: 200,
				settlesAfterArrival: true,
				framesBounded: true,
				offsetsOrdered: true,
				starts: { x: 0, y: 0, o: 0 },
				ends: { x: 440, y: 0, r: 0, o: 1 },
				midwayBetween: true,
				snap: { durationMs: 0, frames: [[3, 0], [3, 0]] },
				drag: { durationMs: 90, frames: [[0, 0, 0], [90, 0, 1]] },
			},
		);
	});
});
