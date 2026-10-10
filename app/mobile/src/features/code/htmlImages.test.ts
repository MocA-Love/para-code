// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { HTML_IMAGE_FETCH_CONCURRENCY, HtmlImageQueue, buildHtmlImageDeliverScript, parseHtmlImageRequest, type HtmlImagePriority } from './htmlImages.js';

const ask = (index: number, priority: HtmlImagePriority) => JSON.stringify({ type: 'paradisHtmlImage', index, priority });

/** 取り寄せを手で終わらせられる PC の代わり。 */
function fakeHost(count: number) {
	const calls: number[] = [];
	const delivered: [number, string][] = [];
	const waiters = new Map<number, { resolve(data: string): void; reject(error: Error): void }>();
	let stale = 0;
	const host = {
		count,
		fetch: (index: number) => {
			calls.push(index);
			return new Promise<string>((resolve, reject) => waiters.set(index, { resolve, reject }));
		},
		deliver: (index: number, data: string) => { delivered.push([index, data]); },
		isStale: (error: unknown) => error instanceof Error && error.message === 'stale',
		onStale: () => { stale++; },
	};
	const settle = async (index: number, outcome: string | Error) => {
		const waiter = waiters.get(index);
		waiters.delete(index);
		if (outcome instanceof Error) {
			waiter?.reject(outcome);
		} else {
			waiter?.resolve(outcome);
		}
		await new Promise(resolve => setTimeout(resolve, 0));
	};
	return { host, calls, delivered, settle, stale: () => stale };
}

describe('parseHtmlImageRequest', () => {
	test('取り寄せの頼みだけを読み、番号の範囲と順番の名前を確かめる', () => {
		expect([
			parseHtmlImageRequest(ask(2, 'visible'), 3),
			parseHtmlImageRequest(ask(3, 'visible'), 3),
			parseHtmlImageRequest(ask(-1, 'idle'), 3),
			parseHtmlImageRequest(ask(1.5, 'idle'), 3),
			parseHtmlImageRequest(JSON.stringify({ type: 'paradisHtmlImage', index: 0, priority: 'soon' }), 3),
			parseHtmlImageRequest(JSON.stringify({ type: 'paradisFind', index: 0, priority: 'idle' }), 3),
			parseHtmlImageRequest('not json', 3),
		]).toEqual([{ index: 2, priority: 'visible' }, undefined, undefined, undefined, undefined, undefined, undefined]);
	});
});

describe('HtmlImageQueue', () => {
	test('同時に取り寄せるのは 2 枚まで。押した画像 → 見えている画像 → 近い画像 → 残り の順', async () => {
		const pc = fakeHost(6);
		const queue = new HtmlImageQueue(pc.host);
		expect(queue.handleMessage(ask(0, 'idle'))).toBe(true);
		queue.handleMessage(ask(1, 'idle'));
		queue.handleMessage(ask(2, 'near'));
		queue.handleMessage(ask(3, 'visible'));
		queue.handleMessage(ask(4, 'idle'));
		// 待っている近い画像を押した（繰り上がる）。同じ番号を低い順番で頼み直しても下がらない
		queue.handleMessage(ask(4, 'click'));
		queue.handleMessage(ask(4, 'idle'));
		expect(pc.calls).toEqual([0, 1]);
		await pc.settle(0, 'data:image/png;base64,AAAA');
		await pc.settle(1, 'data:image/png;base64,BBBB');
		await pc.settle(4, 'data:image/png;base64,EEEE');
		await pc.settle(3, 'data:image/png;base64,DDDD');
		await pc.settle(2, 'data:image/png;base64,CCCC');
		expect({ calls: pc.calls, delivered: pc.delivered.map(([index]) => index), concurrency: HTML_IMAGE_FETCH_CONCURRENCY }).toEqual({
			calls: [0, 1, 4, 3, 2],
			delivered: [0, 1, 4, 3, 2],
			concurrency: 2,
		});
	});

	test('閉じた後は待っている分を捨て、取り寄せ中の結果もページへ返さない', async () => {
		const pc = fakeHost(4);
		const queue = new HtmlImageQueue(pc.host);
		for (let index = 0; index < 4; index++) {
			queue.handleMessage(ask(index, 'visible'));
		}
		queue.dispose();
		await pc.settle(0, 'data:image/png;base64,AAAA');
		await pc.settle(1, 'data:image/png;base64,BBBB');
		queue.handleMessage(ask(2, 'click'));
		expect({ calls: pc.calls, delivered: pc.delivered }).toEqual({ calls: [0, 1], delivered: [] });
	});

	test('失敗した画像は 1 回だけやり直し、PC の中身が変わっていたら止めて読み直しを頼む', async () => {
		const pc = fakeHost(3);
		const queue = new HtmlImageQueue(pc.host);
		queue.handleMessage(ask(0, 'visible'));
		await pc.settle(0, new Error('offline'));
		await pc.settle(0, new Error('offline'));
		queue.handleMessage(ask(0, 'click'));
		queue.handleMessage(ask(1, 'visible'));
		queue.handleMessage(ask(2, 'idle'));
		await pc.settle(1, new Error('stale'));
		await pc.settle(2, 'data:image/png;base64,CCCC');
		queue.handleMessage(ask(2, 'click'));
		expect({ calls: pc.calls, delivered: pc.delivered, stale: pc.stale() }).toEqual({ calls: [0, 0, 1, 2], delivered: [], stale: 1 });
	});

	test('画像でない値はページへ返さない。検索などほかのメッセージは受けない', async () => {
		const pc = fakeHost(1);
		const queue = new HtmlImageQueue(pc.host);
		expect(queue.handleMessage(JSON.stringify({ type: 'paradisFind', token: 'x', seq: 1 }))).toBe(false);
		queue.handleMessage(ask(0, 'visible'));
		await pc.settle(0, 'javascript:alert(1)');
		expect(pc.delivered).toEqual([]);
	});
});

describe('buildHtmlImageDeliverScript', () => {
	test('元の data: の文字列をそのまま、取り寄せのスクリプトの関数へ渡す', () => {
		const received: unknown[] = [];
		const data = 'data:image/png;base64,iVBO\nRw0K"</script>';
		const window = { __paradisDeliverHtmlImage: (...args: unknown[]) => { received.push(args); } };
		new Function('window', buildHtmlImageDeliverScript(7, data))(window);
		expect(received).toEqual([['7', data]]);
	});
});
