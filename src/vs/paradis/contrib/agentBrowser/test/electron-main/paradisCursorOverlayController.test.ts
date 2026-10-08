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

/** The command the generated script carries (the JSON argument of the self-calling function). */
function payloadOf(code: string): Record<string, unknown> {
	return JSON.parse(/\}\)\((?<json>\{[\s\S]*\})\)$/.exec(code)!.groups!.json);
}

/** Records the payloads a target receives, with only the fields a test looks at. */
function recordPayloads(target: TestTarget, fields: readonly string[]): Record<string, unknown>[] {
	const seen: Record<string, unknown>[] = [];
	const original = target.webContents.executeJavaScriptInIsolatedWorld;
	target.webContents.executeJavaScriptInIsolatedWorld = (worldId, scripts) => {
		const payload = payloadOf(scripts[0].code);
		const picked: Record<string, unknown> = {};
		for (const field of fields) {
			if (payload[field] !== undefined) {
				picked[field] = payload[field];
			}
		}
		seen.push(picked);
		return original(worldId, scripts);
	};
	return seen;
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
				// The first one appears in place; the second plays the cursor-motion arc, which settles after arriving.
				durations: [0, target.durations[1] >= 200 ? target.durations[1] : -1],
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

	test('a capture whose hide failed is still restored, so the cursor cannot stay invisible', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController(() => true, () => 0);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
		// The page is hidden by the time the hide fails, and it honours that flag on later moves,
		// so skipping the restore would leave an invisible cursor behind for good.
		// A slow page still gets its flash; 'captured' clears the hidden flag just like 'show'.
		target.reply = async () => { throw new Error('hide did not settle'); };
		await controller.hideForCapture(target);
		target.reply = async () => 0;
		controller.afterCapture(target, true);

		assert.deepStrictEqual(target.commands, ['move', 'hide', 'captured']);
	});

	test('typing nudges the cursor onto the focused element, throttled to a few per burst', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		controller.onKeyEvent(target);
		clock += 10;
		controller.onKeyEvent(target);
		clock += 10;
		controller.onKeyEvent(target);
		clock += 1_000;
		controller.onKeyEvent(target);

		assert.deepStrictEqual(target.commands, ['focus', 'focus']);
	});

	test('a click still shows the cursor when the preceding move never landed', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController();

		// No move at all: the page-side script creates the cursor for the press itself, so the
		// click is never silent.
		await controller.onMouseEvent(target, { type: 'mousePressed', x: 30, y: 40, button: 'left' });

		assert.deepStrictEqual(target.commands, ['press']);
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

	test('an occasional failure does not black out the overlay, but a broken page eventually does', async () => {
		const target = new TestTarget();
		const clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		const move = async (x: number) => {
			await controller.onMouseEvent(target, { type: 'mouseMoved', x, y: 0 });
			// The detached run settles on a later microtask than onMouseEvent returns.
			await Promise.resolve(); await Promise.resolve();
		};

		// Navigations reject the injection routinely; a single one must not cost 30 seconds.
		target.reply = async () => { throw new Error('frame was detached'); };
		await move(1);
		target.reply = async () => 0;
		await move(2);
		await move(3);

		// A genuinely broken page fails over and over, and that does earn the backoff.
		target.reply = async () => { throw new Error('frame was detached'); };
		await move(4); await move(5); await move(6);
		await move(7);

		assert.deepStrictEqual(target.commands, ['move', 'move', 'move', 'move', 'move', 'move']);
	});

	test('a settings lookup that throws never escapes into input dispatch or capture', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController(() => { throw new Error('configuration unavailable'); });

		const waited = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 1, y: 1 });
		await controller.hideForCapture(target);
		controller.afterCapture(target, true);

		assert.deepStrictEqual({ waited, commands: target.commands }, { waited: 0, commands: ['hide', 'show'] });
	});

	test('a move right before a press glides without delaying dispatch, and the ripple waits for the arrival', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		const delays: string[] = [];
		target.reply = async kind => kind;
		const original = target.webContents.executeJavaScriptInIsolatedWorld;
		target.webContents.executeJavaScriptInIsolatedWorld = (worldId, scripts) => {
			const delay = /"delayMs":(\d+)/.exec(scripts[0].code);
			if (delay) {
				delays.push(delay[1]);
			}
			return original(worldId, scripts);
		};

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 0, y: 0 });
		clock += 1_000;
		// 440px => a 200ms glide, but a press follows, so nothing waits.
		const beforePress = await controller.onMouseEvent(target, { type: 'mouseMoved', x: 440, y: 0 }, { pressFollows: true });
		clock += 50;
		await controller.onMouseEvent(target, { type: 'mousePressed', x: 440, y: 0, button: 'left' });

		assert.deepStrictEqual(
			{ beforePress, commands: target.commands, durations: target.durations, delays },
			{ beforePress: 0, commands: ['move', 'move', 'press'], durations: [0, target.durations[1] >= 200 ? target.durations[1] : -1], delays: ['150'] },
		);
	});

	test('the wait is capped by the caller and skipped on calm or undrawable pages and after a navigation', async () => {
		const capped = new TestTarget();
		const calm = new TestTarget();
		calm.reply = async () => ({ calm: true, blocked: false });
		const blocked = new TestTarget();
		blocked.reply = async () => ({ calm: false, blocked: true });
		const navigated = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);

		for (const target of [capped, calm, blocked, navigated]) {
			await controller.onMouseEvent(target, { type: 'mouseMoved', x: 0, y: 0 });
		}
		// Let the fire-and-forget scripts settle so the page traits are known.
		await Promise.resolve();
		await Promise.resolve();
		controller.onNavigated(navigated);
		clock += 1_000;
		const waits = {
			capped: await controller.onMouseEvent(capped, { type: 'mouseMoved', x: 880, y: 0 }, { maxWaitMs: 120 }),
			calm: await controller.onMouseEvent(calm, { type: 'mouseMoved', x: 880, y: 0 }),
			blocked: await controller.onMouseEvent(blocked, { type: 'mouseMoved', x: 880, y: 0 }),
			navigated: await controller.onMouseEvent(navigated, { type: 'mouseMoved', x: 880, y: 0 }),
			afterNavigation: await controller.onMouseEvent(navigated, { type: 'mouseMoved', x: 0, y: 0 }),
		};

		assert.deepStrictEqual(waits, { capped: 120, calm: 0, blocked: 0, navigated: 0, afterNavigation: PARADIS_CURSOR_OVERLAY_TUNING.maxMs });
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

	test('a tool state parks the cursor on a fresh page, reading frames are thinned before reaching the page, and a snapshot flashes only outside a capture', async () => {
		const target = new TestTarget();
		let clock = 10_000;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		const seen = recordPayloads(target, ['kind', 'status', 'park', 'box', 'rect', 'clickText', 'since']);
		const field = { x: 10, y: 20, width: 100, height: 30 };
		const button = { x: 10, y: 80, width: 100, height: 30 };

		controller.noteStatus(target, 'script', undefined, undefined, undefined, { since: 9_990 });
		controller.noteLook(target, field, false);
		// The same element again, and another element within a second: nothing is sent to the page.
		controller.noteLook(target, field, false);
		clock += 500;
		controller.noteLook(target, button, false);
		clock += 1_000;
		controller.noteLook(target, button, true);
		await controller.hideForCapture(target);
		clock += 2_000;
		controller.noteLook(target, undefined, true);
		controller.afterCapture(target, true, { x: 0, y: 100, width: 50, height: 50, doc: true });

		assert.deepStrictEqual(seen, [
			{ kind: 'status', status: 'script', park: true, clickText: 'スクリプトでクリック', since: 9_990 },
			{ kind: 'look', box: field },
			{ kind: 'flash', rect: button },
			{ kind: 'look', box: button },
			{ kind: 'hide' },
			{ kind: 'captured', rect: { x: 0, y: 100, width: 50, height: 50, doc: true } },
		]);
	});

	test('a snapshot flash does not use up the screenshot flash right after it', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		controller.noteLook(target, undefined, true);
		clock += 100;
		await controller.hideForCapture(target);
		const flashed = controller.afterCapture(target, true);
		assert.deepStrictEqual({ flashed, commands: target.commands }, { flashed: true, commands: ['flash', 'hide', 'captured'] });
	});

	test('the idle at the end of a tool still reaches a page that went to the background', async () => {
		const target = new TestTarget();
		const controller = new ParadisCursorOverlayController(() => true, () => 0);
		controller.noteStatus(target, 'script', undefined, undefined);
		target.visible = false;
		controller.noteStatus(target, 'idle', undefined, undefined);
		// A page that never had a cursor gets nothing, and neither does a destroyed one.
		const fresh = new TestTarget();
		fresh.visible = false;
		controller.noteStatus(fresh, 'idle', undefined, undefined);
		target.destroyed = true;
		controller.noteStatus(target, 'idle', undefined, undefined);
		assert.deepStrictEqual({ target: target.commands, fresh: fresh.commands }, { target: ['status', 'status'], fresh: [] });
	});

	test('after a navigation the recent cursor comes back where it was, once more on dom-ready, and not after cleanup or a long pause', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		const seen = recordPayloads(target, ['kind', 'status', 'transient', 'frames']);

		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 100, y: 50 });
		clock += 2_000;
		controller.noteStatus(target, 'loading', undefined, undefined);
		controller.onNavigated(target);
		controller.onDomReady(target);
		// Without a running tool, the name tag says loading only for a moment.
		controller.noteStatus(target, 'idle', undefined, undefined);
		controller.onNavigated(target);
		// A move before dom-ready already drew the cursor on the new page, so dom-ready does not pull it back.
		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 300, y: 50 });
		controller.onDomReady(target);
		const beforeCleanup = seen.length;
		clock += PARADIS_CURSOR_OVERLAY_TUNING.idleMs + 1;
		controller.onNavigated(target);
		controller.removeOverlay(target);
		controller.onNavigated(target);

		const at = (x: number, y: number) => [{ x, y, r: 0, o: 1 }];
		assert.deepStrictEqual({ seen: seen.slice(0, beforeCleanup).map(p => p.kind === 'move' ? 'move' : p), after: seen.slice(beforeCleanup).map(p => p.kind) }, {
			seen: [
				'move',
				{ kind: 'status', status: 'loading' },
				{ kind: 'status', status: 'loading', frames: at(100, 50) },
				{ kind: 'status', status: 'loading', frames: at(100, 50) },
				{ kind: 'status', status: 'idle' },
				{ kind: 'status', status: 'loading', transient: true, frames: at(100, 50) },
				'move',
			],
			after: ['remove'],
		});
	});

	test('a tool state that never got its end is not brought back as running after a navigation half a minute later', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		const seen = recordPayloads(target, ['kind', 'status', 'transient']);
		controller.noteStatus(target, 'script', undefined, undefined);
		clock += 31_000;
		controller.onNavigated(target);
		assert.deepStrictEqual(seen, [{ kind: 'status', status: 'script' }, { kind: 'status', status: 'loading', transient: true }]);
	});

	test('releases, wheels, special keys and tool states reach the page without delaying input', async () => {
		const target = new TestTarget();
		let clock = 0;
		const controller = new ParadisCursorOverlayController(() => true, () => clock);
		const keys: string[] = [];
		const original = target.webContents.executeJavaScriptInIsolatedWorld;
		target.webContents.executeJavaScriptInIsolatedWorld = (worldId, scripts) => {
			const key = /"key":"([^"]+)"/.exec(scripts[0].code);
			if (key) {
				keys.push(key[1]);
			}
			return original(worldId, scripts);
		};

		// Nothing to release or scroll before the cursor exists.
		const early = await controller.onMouseEvent(target, { type: 'mouseReleased', x: 1, y: 1, button: 'left' });
		await controller.onMouseEvent(target, { type: 'mouseMoved', x: 10, y: 10 });
		const waits = [
			early,
			await controller.onMouseEvent(target, { type: 'mouseReleased', x: 10, y: 10, button: 'left' }),
			await controller.onMouseEvent(target, { type: 'mouseWheel', x: 10, y: 10, deltaX: 0, deltaY: 120 }),
			// Throttled: a burst of wheel events shows one arrow.
			await controller.onMouseEvent(target, { type: 'mouseWheel', x: 10, y: 10, deltaX: 0, deltaY: 120 }),
		];
		controller.onKeyEvent(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });
		controller.onKeyEvent(target, 'Input.insertText', { text: 'secret' });
		clock += 1_000;
		controller.noteStatus(target, 'failed', undefined, { x: 300, y: 40 });

		assert.deepStrictEqual(
			{ waits, commands: target.commands, keys },
			{ waits: [0, 0, 0, 0], commands: ['move', 'release', 'wheel', 'focus', 'status'], keys: ['Enter'] },
		);
	});
});
