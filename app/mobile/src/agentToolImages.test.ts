// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { ToolImageCache, formatImageBytes, loadToolImage, toolImageCache, toolImageDataUri, toolImageInFlightCount, toolImageKey } from './agentToolImages.js';

describe('toolImageKey', () => {
	it('separates the same rev across epochs and panes', () => {
		expect(toolImageKey('pane-1', 'epoch-a', 3, 0)).not.toBe(toolImageKey('pane-1', 'epoch-b', 3, 0));
		expect(toolImageKey('pane-1', 'epoch-a', 3, 0)).not.toBe(toolImageKey('pane-2', 'epoch-a', 3, 0));
		expect(toolImageKey('pane-1', 'epoch-a', 3, 0)).not.toBe(toolImageKey('pane-1', 'epoch-a', 3, 1));
	});
});

describe('ToolImageCache', () => {
	it('drops the oldest entries once either limit is exceeded', () => {
		const cache = new ToolImageCache(2, 1000);
		cache.set('a', { uri: 'data:image/png;base64,a', bytes: 100 });
		cache.set('b', { uri: 'data:image/png;base64,b', bytes: 100 });
		cache.set('c', { uri: 'data:image/png;base64,c', bytes: 100 });
		expect([cache.get('a'), cache.get('b')?.uri, cache.get('c')?.uri, cache.stats()]).toEqual([
			undefined, 'data:image/png;base64,b', 'data:image/png;base64,c', { count: 2, bytes: 200 },
		]);
	});

	it('keeps byte accounting correct when a key is replaced', () => {
		const cache = new ToolImageCache(4, 1000);
		cache.set('a', { uri: 'x', bytes: 300 });
		cache.set('a', { uri: 'y', bytes: 100 });
		expect([cache.get('a')?.uri, cache.stats()]).toEqual(['y', { count: 1, bytes: 100 }]);
	});

	it('refuses an image that alone exceeds the byte budget', () => {
		const cache = new ToolImageCache(4, 500);
		cache.set('big', { uri: 'x', bytes: 900 });
		expect([cache.get('big'), cache.stats()]).toEqual([undefined, { count: 0, bytes: 0 }]);
	});

	it('evicts by bytes even when the entry count is within the limit', () => {
		const cache = new ToolImageCache(10, 250);
		cache.set('a', { uri: 'a', bytes: 100 });
		cache.set('b', { uri: 'b', bytes: 100 });
		cache.set('c', { uri: 'c', bytes: 100 });
		expect([cache.get('a'), cache.stats()]).toEqual([undefined, { count: 2, bytes: 200 }]);
	});

	it('clears everything including the byte total', () => {
		const cache = new ToolImageCache();
		cache.set('a', { uri: 'a', bytes: 100 });
		cache.clear();
		expect([cache.get('a'), cache.stats()]).toEqual([undefined, { count: 0, bytes: 0 }]);
	});
});

describe('toolImageDataUri', () => {
	it('builds a data URI usable by <Image>', () => {
		expect(toolImageDataUri('image/png', 'AAEC')).toBe('data:image/png;base64,AAEC');
	});
});

describe('loadToolImage', () => {
	it('shares one request between concurrent callers and caches the result', async () => {
		toolImageCache.clear();
		let calls = 0;
		const fetchImage = () => { calls++; return Promise.resolve({ mediaType: 'image/png', data: 'AAEC' }); };
		const [first, second] = await Promise.all([
			loadToolImage('shared', fetchImage),
			loadToolImage('shared', fetchImage),
		]);
		const third = await loadToolImage('shared', fetchImage);
		expect([calls, first.uri, second.uri, third.uri, toolImageInFlightCount()])
			.toEqual([1, 'data:image/png;base64,AAEC', 'data:image/png;base64,AAEC', 'data:image/png;base64,AAEC', 0]);
	});

	it('does not keep a failed request in flight', async () => {
		toolImageCache.clear();
		await expect(loadToolImage('failing', () => Promise.reject(new Error('保持期限を過ぎています')))).rejects.toThrow('保持期限を過ぎています');
		let retried = false;
		await loadToolImage('failing', () => { retried = true; return Promise.resolve({ mediaType: 'image/png', data: 'AAEC' }); });
		expect([retried, toolImageInFlightCount()]).toEqual([true, 0]);
	});
});

describe('formatImageBytes', () => {
	it('formats each magnitude and hides unusable values', () => {
		expect([formatImageBytes(0), formatImageBytes(-1), formatImageBytes(512), formatImageBytes(220_000), formatImageBytes(2_400_000)])
			.toEqual(['', '', '512 B', '215 KB', '2.3 MB']);
	});
});
