// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { openUrlInPcBrowser, pickOpenedBrowserTarget } from './terminalLinkOpen.js';

describe('pickOpenedBrowserTarget', () => {
	const existing = { targetId: 'old', url: 'http://localhost:3000/' };

	it('prefers a page that appeared after opening and whose URL matches', () => {
		const targets = [existing, { targetId: 'other', url: 'https://example.com/' }, { targetId: 'new', url: 'http://LOCALHOST:3000/#top' }];
		expect(pickOpenedBrowserTarget(targets, 'http://localhost:3000', new Set(['old', 'other']))?.targetId).toBe('new');
	});

	it('falls back to a new page on the same origin, and never takes a new page on another origin', () => {
		const sameOrigin = [existing, { targetId: 'new', url: 'http://localhost:3000/login?next=%2F' }];
		const otherOrigin = [existing, { targetId: 'new', url: 'https://auth.example.com/' }];
		expect([
			pickOpenedBrowserTarget(sameOrigin, 'http://localhost:3000/app', new Set(['old']))?.targetId,
			pickOpenedBrowserTarget(otherOrigin, 'http://localhost:3000/app', new Set(['old']))?.targetId,
		]).toEqual(['new', undefined]);
	});

	it('uses an already open page with the same URL when no page was added', () => {
		expect(pickOpenedBrowserTarget([existing], 'http://localhost:3000', new Set(['old']))?.targetId).toBe('old');
		expect(pickOpenedBrowserTarget([existing], 'http://localhost:4000', new Set(['old']))).toBeUndefined();
	});
});

describe('openUrlInPcBrowser', () => {
	it('opens on the PC and polls the page list until the new page shows up', async () => {
		const events: string[] = [];
		let listed = 0;
		const picked = await openUrlInPcBrowser('http://localhost:5173', {
			open: async () => { events.push('open'); },
			listTargets: async () => {
				listed++;
				events.push(`list ${listed}`);
				return listed < 3 ? [{ targetId: 'a', url: 'https://example.com' }] : [{ targetId: 'a', url: 'https://example.com' }, { targetId: 'b', url: 'http://localhost:5173/' }];
			},
			wait: async () => { events.push('wait'); },
		});
		expect({ picked: picked?.targetId, events }).toEqual({ picked: 'b', events: ['list 1', 'open', 'wait', 'list 2', 'wait', 'list 3'] });
	});

	it('rejects when the PC could not open the URL and gives up quietly when the page never appears', async () => {
		await expect(openUrlInPcBrowser('http://localhost:1', {
			open: async () => { throw new Error('boom'); },
			listTargets: async () => [],
			wait: async () => { },
		})).rejects.toThrow('boom');
		await expect(openUrlInPcBrowser('http://localhost:1', {
			open: async () => { },
			listTargets: async () => { throw new Error('offline'); },
			wait: async () => { },
		})).resolves.toBeUndefined();
	});
});
