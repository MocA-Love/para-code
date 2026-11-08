// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { buildOfficeRenderProbe } from './officeRenderProbe.js';

type ProbeEvent =
	/** `#content` が変わる（`root` なら期待する要素が出る）。 */
	| { readonly at: number; readonly kind: 'mutate'; readonly root?: boolean }
	/** ページの同期の処理で `ms` の間タイマーも止まる。 */
	| { readonly at: number; readonly kind: 'block'; readonly ms: number };

/**
 * probe を偽の時計・タイマー・DOM の上で動かし、知らせた時刻と結果を返す。文書は最後まで描いている途中
 * （`__paradisOfficeBusy` が true のまま）とする。
 */
function runProbe(events: readonly ProbeEvent[]): { readonly at: number; readonly hasExpectedRoot: boolean } {
	let now = 0;
	let rootPresent = false;
	let posted: { at: number; hasExpectedRoot: boolean } | undefined;
	const timers: { due: number; run: () => void }[] = [];
	const content = { contains: (node: object) => node === content };
	let notify: ((records: { target: object }[]) => void) | undefined;
	class FakeMutationObserver {
		constructor(callback: (records: { target: object }[]) => void) { notify = callback; }
		observe(): void { }
		disconnect(): void { notify = undefined; }
	}
	const fakeWindow = {
		__paradisOfficeBusy: true,
		ReactNativeWebView: {
			postMessage: (data: string) => {
				posted = { at: now, hasExpectedRoot: (JSON.parse(data) as { hasExpectedRoot: boolean }).hasExpectedRoot };
			},
		},
	};
	const fakeDocument = {
		documentElement: {},
		getElementById: (id: string) => (id === 'content' ? content : null),
		querySelector: () => (rootPresent ? {} : null),
	};
	const fakeSetTimeout = (run: () => void, ms: number) => { timers.push({ due: now + ms, run }); };
	const fakeDate = { now: () => now };
	new Function('window', 'document', 'MutationObserver', 'setTimeout', 'Date', buildOfficeRenderProbe(1, '.root'))(
		fakeWindow, fakeDocument, FakeMutationObserver, fakeSetTimeout, fakeDate,
	);
	const pending = [...events].sort((a, b) => a.at - b.at);
	while (posted === undefined) {
		timers.sort((a, b) => a.due - b.due);
		const timer = timers[0];
		const event = pending[0];
		if (event !== undefined && (timer === undefined || event.at < timer.due)) {
			pending.shift();
			now = Math.max(now, event.at);
			if (event.kind === 'block') {
				now += event.ms;
			} else {
				rootPresent = rootPresent || event.root === true;
				notify?.([{ target: content }]);
			}
		} else if (timer !== undefined) {
			timers.shift();
			now = Math.max(now, timer.due);
			timer.run();
		} else {
			throw new Error('probe never reported');
		}
	}
	return posted;
}

describe('officeRenderProbe', () => {
	test('does not give up before the first change of the content, even if it comes after 30 seconds', () => {
		expect(runProbe([
			{ at: 30_000, kind: 'mutate' },
			{ at: 33_000, kind: 'mutate', root: true },
		])).toEqual({ at: 33_000, hasExpectedRoot: true });
	});

	test('does not count a 6 second synchronous pause as a stall', () => {
		expect(runProbe([
			{ at: 1_000, kind: 'mutate' },
			{ at: 3_000, kind: 'block', ms: 6_000 },
			{ at: 9_500, kind: 'mutate' },
			{ at: 12_000, kind: 'mutate', root: true },
		])).toEqual({ at: 12_000, hasExpectedRoot: true });
	});

	test('gives up 5 seconds after the content stops changing', () => {
		expect(runProbe([
			{ at: 1_000, kind: 'mutate' },
		])).toEqual({ at: 6_000, hasExpectedRoot: false });
	});

	test('keeps the 60 second limit when the content never changes', () => {
		expect(runProbe([])).toEqual({ at: 62_000, hasExpectedRoot: false });
	});
});
