// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { createTermReadyWatchdog, TERM_READY_WATCHDOG_MS } from './termReadyWatchdog.js';

function harness(options: { foreground?: boolean } = {}) {
	let foreground = options.foreground ?? true;
	const events: string[] = [];
	let pending: (() => void) | undefined;
	const watchdog = createTermReadyWatchdog({
		isForeground: () => foreground,
		reload: () => events.push('reload'),
		fail: () => events.push('fail'),
		setTimeout: (callback, ms) => {
			events.push(`arm ${ms}`);
			pending = callback;
			return 1;
		},
		clearTimeout: () => {
			pending = undefined;
		},
	});
	const expire = () => {
		const callback = pending;
		pending = undefined;
		callback?.();
	};
	return { watchdog, events, expire, setForeground: (value: boolean) => { foreground = value; }, armed: () => pending !== undefined };
}

describe('createTermReadyWatchdog', () => {
	it('reloads once, then reports a failure when the view still does not become ready', () => {
		const { watchdog, events, expire } = harness();
		watchdog.arm();
		expire();
		expire();
		expect(events).toEqual([`arm ${TERM_READY_WATCHDOG_MS}`, 'reload', `arm ${TERM_READY_WATCHDOG_MS}`, 'fail']);
	});

	it('does nothing once the view reports ready', () => {
		const { watchdog, events, armed } = harness();
		watchdog.arm();
		watchdog.ready();
		expect({ events, armed: armed() }).toEqual({ events: [`arm ${TERM_READY_WATCHDOG_MS}`], armed: false });
	});

	it('defers the judgement while the app is in the background', () => {
		const { watchdog, events, expire, setForeground } = harness({ foreground: false });
		watchdog.arm();
		expire();
		setForeground(true);
		expire();
		expect(events).toEqual([`arm ${TERM_READY_WATCHDOG_MS}`, `arm ${TERM_READY_WATCHDOG_MS}`, 'reload', `arm ${TERM_READY_WATCHDOG_MS}`]);
	});

	it('gives a later load its own automatic reload after a successful one', () => {
		const { watchdog, events, expire } = harness();
		watchdog.arm();
		expire();
		watchdog.ready();
		// WebView のプロセスが落ちて読み直した。
		watchdog.arm();
		expire();
		expect(events.filter(event => event === 'reload' || event === 'fail')).toEqual(['reload', 'reload']);
	});

	it('retry reloads and reports a failure on the next timeout without another automatic reload', () => {
		const { watchdog, events, expire } = harness();
		watchdog.retry();
		expire();
		expect(events).toEqual(['reload', `arm ${TERM_READY_WATCHDOG_MS}`, 'fail']);
	});

	it('stops after dispose and can be armed again when the effect is re-attached', () => {
		const { watchdog, events, expire, armed } = harness();
		watchdog.arm();
		watchdog.dispose();
		expire();
		const afterDispose = [...events];
		watchdog.arm();
		expect({ afterDispose, armed: armed() }).toEqual({ afterDispose: [`arm ${TERM_READY_WATCHDOG_MS}`], armed: true });
	});
});
