/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { browserViewIsolatedWorldId } from '../../../../../platform/browserView/common/browserView.js';
import { PARADIS_CURSOR_OVERLAY_TUNING } from '../../common/paradisCursorOverlay.js';
import { IParadisCursorOverlayTarget, ParadisCursorOverlayController } from '../../electron-main/paradisCursorOverlayController.js';

/** Records every script the controller runs, and lets a test decide what the page "returns". */
class TestTarget implements IParadisCursorOverlayTarget {

	readonly worlds: number[] = [];
	readonly commands: string[] = [];
	readonly durations: number[] = [];
	destroyed = false;
	visible = true;
	reply: (kind: string) => Promise<unknown> = async () => 0;

	readonly webContents = {
		isDestroyed: () => this.destroyed,
		executeJavaScriptInIsolatedWorld: (worldId: number, scripts: readonly { readonly code: string }[]) => {
			this.worlds.push(worldId);
			const code = scripts[0].code;
			this.commands.push(kindOf(code));
			const duration = /"durationMs":(-?\d+)/.exec(code);
			if (duration) {
				this.durations.push(Number(duration[1]));
			}
			return this.reply(kindOf(code));
		},
	};

	getState(): { readonly visible: boolean } {
		return { visible: this.visible };
	}
}

/** Reads the command kind back out of the generated script's embedded payload. */
function kindOf(code: string): string {
	return /"kind":"([a-z]+)"/.exec(code)?.[1] ?? '<unknown>';
}

suite('Paradis Cursor Overlay Controller', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a move runs in the browser view isolated world and waits for its own glide', async () => {
		const target = new TestTarget();
		let clock = 1_000;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		// First move has no previous position, so it only waits for the fade-in.
		const first = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 0, y: 0 });
		clock += 50;
		// 440px away at 2.2px/ms => 200ms.
		const second = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 440, y: 0 });

		assert.deepStrictEqual(
			{ first, second, commands: target.commands, durations: target.durations, worlds: target.worlds },
			{
				first: PARADIS_CURSOR_OVERLAY_TUNING.appearMs,
				second: 200,
				commands: ['move', 'move'],
				durations: [PARADIS_CURSOR_OVERLAY_TUNING.appearMs, 200],
				worlds: [browserViewIsolatedWorldId, browserViewIsolatedWorldId],
			},
		);
	});

	test('the page is never asked how long to wait, so a hung page cannot stall dispatch', async () => {
		const target = new TestTarget();
		let clock = 0;
		// A page that never answers must not delay the caller beyond the computed glide.
		target.reply = () => new Promise(() => { });
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 0, y: 0 });
		clock += 10;
		const waited = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 10_000, y: 0 });

		assert.deepStrictEqual({ waited, commands: target.commands }, { waited: PARADIS_CURSOR_OVERLAY_TUNING.maxMs, commands: ['move', 'move'] });
	});

	test('dragging glides are capped much shorter than free moves', async () => {
		const drag = new TestTarget();
		const free = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		await controller.onMouseEvent(drag, { type: 'mouseMoved', x: 0, y: 0 });
		await controller.onMouseEvent(free, { type: 'mouseMoved', x: 0, y: 0 });
		clock += 10;
		const dragging = await controller.onMouseEvent(drag, { type: 'mouseMoved', x: 5_000, y: 0, buttons: 1 });
		const moving = await controller.onMouseEvent(free, { type: 'mouseMoved', x: 5_000, y: 0 });

		assert.deepStrictEqual(
			{ dragging, moving },
			{ dragging: PARADIS_CURSOR_OVERLAY_TUNING.dragMaxMs, moving: PARADIS_CURSOR_OVERLAY_TUNING.maxMs },
		);
	});

	test('a stale position falls back to a fade-in instead of a long glide across the page', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 0, y: 0 });
		// The page removes itself after idleMs, so anything older than that is not a glide origin.
		clock += PARADIS_CURSOR_OVERLAY_TUNING.idleMs + 1;
		const waited = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 900, y: 0 });

		assert.strictEqual(waited, PARADIS_CURSOR_OVERLAY_TUNING.appearMs);
	});

	test('only moves and presses reach the page, and presses never delay dispatch', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		const waits = [
			await controller.onMouseEvent(target, { type: 'mouseReleased', x: 1, y: 1, button: 'left' }),
			await controller.onMouseEvent(target, { type: 'mouseWheel', x: 1, y: 1, deltaX: 0, deltaY: 100 }),
			await controller.onMouseEvent(target, { type: 'mousePressed', x: 1, y: 1, button: 'left' }),
		];

		assert.deepStrictEqual({ waits, commands: target.commands }, { waits: [0, 0, 0], commands: ['press'] });
	});

	test('nothing is injected when the setting is off, the tab is hidden, or the view is gone', async () => {
		const disabled = new TestTarget();
		const hidden = new TestTarget();
		hidden.visible = false;
		const gone = new TestTarget();
		gone.destroyed = true;

		await new ParadisCursorOverlayController(() => false).onMouseEvent(disabled, { type: 'mouseMoved', x: 1, y: 1 });
		await new ParadisCursorOverlayController().onMouseEvent(hidden, { type: 'mouseMoved', x: 1, y: 1 });
		await new ParadisCursorOverlayController().onMouseEvent(gone, { type: 'mouseMoved', x: 1, y: 1 });

		assert.deepStrictEqual([disabled.commands, hidden.commands, gone.commands], [[], [], []]);
	});

	test('turning the setting off clears the cursor already on the page instead of waiting out the idle timer', async () => {
		const target = new TestTarget();
		let on = true;
		const controller = new ParadisCursorOverlayController(() => on);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
		on = false;
		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 2, y: 2 });
		// Only the first disabled event needs to clean up.
		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 3, y: 3 });

		assert.deepStrictEqual(target.commands, ['move', 'remove']);
	});

	test('a capture hides the cursor first and restores it with a flash afterwards, even while hidden', async () => {
		const target = new TestTarget();
		target.visible = false;
		const controller = new ParadisCursorOverlayController();

		await controller.hideForCapture(target);
		controller.afterCapture(target, true);

		assert.deepStrictEqual(target.commands, ['hide', 'captured']);
	});

	test('a failed or disowned capture restores the cursor without flashing the page', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		await controller.hideForCapture(target);
		controller.afterCapture(target, false);

		assert.deepStrictEqual(target.commands, ['hide', 'show']);
	});

	test('overlapping captures keep the cursor hidden until the last one finishes', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		await controller.hideForCapture(target);
		await controller.hideForCapture(target);
		controller.afterCapture(target, true);
		const afterFirstRelease = [...target.commands];
		controller.afterCapture(target, true);

		assert.deepStrictEqual(
			{ afterFirstRelease, final: target.commands },
			{ afterFirstRelease: ['hide', 'hide'], final: ['hide', 'hide', 'captured'] },
		);
	});

	test('a capture that finishes after the agent lets go restores without flashing the page', async () => {
		const unbound = new TestTarget();
		const focused = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		// The page is released (unshared, or the user took focus) while the capture is in flight.
		await controller.onMouseEvent(unbound, { type: 'mouseMoved', x: 1, y: 1 });
		await controller.hideForCapture(unbound);
		controller.removeOverlay(unbound);
		controller.afterCapture(unbound, true);

		// Same race, but the agent never drew a cursor here: the flash must still be suppressed.
		await controller.hideForCapture(focused);
		controller.removeOverlay(focused);
		controller.afterCapture(focused, true);

		assert.deepStrictEqual(
			{ unbound: unbound.commands, focused: focused.commands },
			{ unbound: ['move', 'hide', 'remove', 'show'], focused: ['hide', 'show'] },
		);
	});

	test('a capture whose hide timed out is still restored, so the cursor cannot stay invisible', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController(() => true, () => 0);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
		// A hidden, throttled view can take longer than the hide timeout to settle, which puts the
		// view into the failure backoff. The page is hidden by then and honours that flag on later
		// moves, so skipping the restore would leave an invisible cursor behind for good.
		// A slow page still gets its flash; 'captured' clears the hidden flag just like 'show'.
		target.reply = async () => { throw new Error('hide did not settle'); };
		await controller.hideForCapture(target);
		target.reply = async () => 0;
		controller.afterCapture(target, true);

		assert.deepStrictEqual(target.commands, ['move', 'hide', 'captured']);
	});

	test('a screenshot-only agent still gets a flash without ever moving the cursor', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		await controller.hideForCapture(target);
		controller.afterCapture(target, true);

		assert.deepStrictEqual(target.commands, ['hide', 'captured']);
	});

	test('back-to-back captures restore the cursor but do not strobe the flash', async () => {
		const target = new TestTarget();
		let clock = 10_000;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		controller.afterCapture(target, true);
		clock += 100;
		controller.afterCapture(target, true);
		clock += 5_000;
		controller.afterCapture(target, true);

		assert.deepStrictEqual(target.commands, ['captured', 'show', 'captured']);
	});

	test('cleanup of an existing cursor is never skipped by the setting, visibility, or the failure backoff', async () => {
		/** Puts a cursor on the page, then applies `after` before asking for cleanup. */
		const cleanUpAfter = async (after: (target: TestTarget, setEnabled: (on: boolean) => void) => void) => {
			const target = new TestTarget();
			let on = true;
			const controller = new ParadisCursorOverlayController(() => on, () => 0);
			await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
			after(target, next => { on = next; });
			controller.removeOverlay(target);
			return target.commands;
		};

		const hidden = await cleanUpAfter(target => { target.visible = false; });
		const settingOff = await cleanUpAfter((_target, setEnabled) => setEnabled(false));
		const gone = await cleanUpAfter(target => { target.destroyed = true; });

		// A view whose move failed is now in the failure backoff, but that move is exactly what
		// left a cursor on the page, so the backoff must not swallow the cleanup as well.
		const backedOffTarget = new TestTarget();
		backedOffTarget.reply = async () => { throw new Error('detached frame'); };
		const backoffController = new ParadisCursorOverlayController(() => true, () => 0);
		await backoffController.onMouseEvent(backedOffTarget, { type: 'mouseMoved', x: 1, y: 1 });
		backoffController.removeOverlay(backedOffTarget);
		const backedOff = backedOffTarget.commands;

		assert.deepStrictEqual(
			{ hidden, settingOff, backedOff, gone },
			{
				hidden: ['move', 'remove'],
				settingOff: ['move', 'remove'],
				backedOff: ['move', 'remove'],
				// A destroyed view has nothing left to clean up.
				gone: ['move'],
			},
		);
	});

	test('cleanup does nothing for a view that never had a cursor', () => {
		const target = new TestTarget();
		new ParadisCursorOverlayController().removeOverlay(target);
		assert.deepStrictEqual(target.commands, []);
	});

	test('a page that throws is dropped for a while instead of being retried on every event', async () => {
		const target = new TestTarget();
		let clock = 0;
		target.reply = async () => { throw new Error('detached frame'); };
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 2, y: 2 });
		clock += 60_000;
		target.reply = async () => 0;
		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 3, y: 3 });

		assert.deepStrictEqual(target.commands, ['move', 'move']);
	});

	test('a settings lookup that throws never escapes into input dispatch or capture', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController(() => { throw new Error('configuration unavailable'); });

		const waited = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
		await controller.hideForCapture(target);
		controller.afterCapture(target, true);

		assert.deepStrictEqual({ waited, commands: target.commands }, { waited: 0, commands: ['hide', 'show'] });
	});

	test('non-finite coordinates are never forwarded to the page', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		const waits = [
			await controller.onMouseEvent(target, { type: 'mouseMoved', x: Number.NaN, y: 1 }),
			await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: Number.POSITIVE_INFINITY }),
			await controller.onMouseEvent(target, { type: 'mouseMoved', x: '1', y: 2 }),
		];

		assert.deepStrictEqual({ waits, commands: target.commands }, { waits: [0, 0, 0], commands: [] });
	});
});
