// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';

const stored = new Map<string, string>();
vi.mock('./platform.js', () => ({
	secureKeyStore: {
		getItem: async (key: string) => stored.get(key) ?? null,
		setItem: async (key: string, value: string) => { stored.set(key, value); },
	},
}));

import { DISMISSED_LIMIT, isAsyncQuestionHidden, parseDismissed, useAsyncQuestionDrafts, withDismissed } from './asyncQuestionDrafts.js';

describe('asyncQuestionDrafts', () => {
	test('hides a sent question for a while, a queued reply until it leaves the queue, and a dismissed one', () => {
		const state = { sent: { a: { at: 1_000 }, q: { at: 1_000, queuedText: 'reply' } }, dismissed: ['b'] };
		expect([
			isAsyncQuestionHidden(state, 'a', 30_000), isAsyncQuestionHidden(state, 'a', 70_000),
			isAsyncQuestionHidden(state, 'q', 10_000_000), isAsyncQuestionHidden(state, 'b', 0), isAsyncQuestionHidden(state, 'c', 0),
		]).toEqual([true, false, true, true, false]);
	});

	test('a queued reply that left the queue is held only for the usual while from then', () => {
		const store = useAsyncQuestionDrafts.getState();
		store.markSent(['x'], 'queued reply');
		store.settleQueued(new Set(['queued reply']), 5_000);
		const stillQueued = useAsyncQuestionDrafts.getState().sent['x'];
		store.settleQueued(new Set(), 5_000);
		const state = useAsyncQuestionDrafts.getState();
		expect({ stillQueued: stillQueued?.queuedText, settled: state.sent['x'], hiddenSoon: isAsyncQuestionHidden(state, 'x', 30_000), hiddenLater: isAsyncQuestionHidden(state, 'x', 70_000) })
			.toEqual({ stillQueued: 'queued reply', settled: { at: 5_000 }, hiddenSoon: true, hiddenLater: false });
	});

	test('remembers dismissed questions up to the limit and reads only well-formed saved values', () => {
		const many = Array.from({ length: DISMISSED_LIMIT + 3 }, (_, index) => `id${index}`);
		const kept = withDismissed(['old', 'id1'], many);
		expect({
			length: kept.length, first: kept[0], last: kept[kept.length - 1],
			reAdd: withDismissed(['a', 'b'], ['a']),
			parsed: parseDismissed(JSON.stringify(['a', 1, '', 'b'])), broken: parseDismissed('{'), none: parseDismissed(null),
		}).toEqual({ length: DISMISSED_LIMIT, first: 'id3', last: `id${DISMISSED_LIMIT + 2}`, reAdd: ['b', 'a'], parsed: ['a', 'b'], broken: [], none: [] });
	});
	test('saves dismissed questions so that they stay closed after a restart, merging what was saved before', async () => {
		stored.set('asyncQuestionDismissed', JSON.stringify(['saved']));
		useAsyncQuestionDrafts.getState().dismiss(['new']);
		await vi.waitFor(() => expect(JSON.parse(stored.get('asyncQuestionDismissed') ?? '[]')).toEqual(['saved', 'new']));
		expect(useAsyncQuestionDrafts.getState().dismissed).toEqual(['saved', 'new']);
	});
});
