// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test, vi } from 'vitest';

const stored = new Map<string, string>();
vi.mock('./platform.js', () => ({
	secureKeyStore: {
		getItem: async (key: string) => stored.get(key) ?? null,
		setItem: async (key: string, value: string) => { stored.set(key, value); },
	},
}));

import { dismissKey, DISMISSED_LIMIT, isAsyncQuestionHidden, parseDismissed, useAsyncQuestionDrafts, withDismissed } from './asyncQuestionDrafts.js';

const question = (callId: string, index: number) => ({ id: JSON.stringify(['request_user_input_async', callId, index]), callId, index, count: 1, title: 'q' });

describe('asyncQuestionDrafts', () => {
	test('hides a sent question for a while, a queued reply until it leaves the queue, and a dismissed one', () => {
		const a = question('a', 0);
		const q = question('q', 0);
		const state = { sent: { [a.id]: { at: 1_000 }, [q.id]: { at: 1_000, queuedText: 'reply' } }, dismissed: ['b:0'] };
		expect([
			isAsyncQuestionHidden(state, a, 30_000), isAsyncQuestionHidden(state, a, 70_000),
			isAsyncQuestionHidden(state, q, 10_000_000), isAsyncQuestionHidden(state, question('b', 0), 0), isAsyncQuestionHidden(state, question('c', 0), 0),
			isAsyncQuestionHidden({ sent: undefined, dismissed: [] }, a, 0),
		]).toEqual([true, false, true, true, false, false]);
	});

	test('a queued reply that left the queue is held only for the usual while from then', () => {
		const store = useAsyncQuestionDrafts.getState();
		const x = question('x', 0);
		store.markSent('pane-1', [x.id], 'queued reply');
		store.settleQueued(new Set(['queued reply']), 5_000);
		const stillQueued = useAsyncQuestionDrafts.getState().sent['pane-1']?.[x.id];
		store.settleQueued(new Set(), 5_000);
		const sent = useAsyncQuestionDrafts.getState().sent['pane-1'];
		const state = { sent, dismissed: [] };
		expect({ stillQueued: stillQueued?.queuedText, settled: sent?.[x.id], hiddenSoon: isAsyncQuestionHidden(state, x, 30_000), hiddenLater: isAsyncQuestionHidden(state, x, 70_000) })
			.toEqual({ stillQueued: 'queued reply', settled: { at: 5_000 }, hiddenSoon: true, hiddenLater: false });
	});

	test('cleans up only the pane whose list changed, keeping the drafts and sent marks of other panes', () => {
		const store = useAsyncQuestionDrafts.getState();
		const first = question('call-1', 0);
		const second = question('call-2', 0);
		store.setDraft('pane-a', first.id, { option: 0 });
		store.markSent('pane-a', [first.id], 'queued to a');
		store.setDraft('pane-b', second.id, { text: 'b' });
		store.markSent('pane-b', [second.id]);
		// pane-b の一覧には pane-a の問いが無い。pane-b だけを掃除する
		store.prune('pane-b', []);
		const state = useAsyncQuestionDrafts.getState();
		expect({ draftsA: state.drafts['pane-a'], sentA: state.sent['pane-a']?.[first.id]?.queuedText, draftsB: state.drafts['pane-b'], sentB: state.sent['pane-b'] })
			.toEqual({ draftsA: { [first.id]: { option: 0 } }, sentA: 'queued to a', draftsB: undefined, sentB: undefined });
	});

	test('remembers dismissed questions up to the limit and reads only well-formed saved values', () => {
		const many = Array.from({ length: DISMISSED_LIMIT + 3 }, (_, index) => `id${index}`);
		const kept = withDismissed(['old', 'id1'], many);
		expect({
			limit: DISMISSED_LIMIT, length: kept.length, first: kept[0], last: kept[kept.length - 1],
			reAdd: withDismissed(['a', 'b'], ['a']),
			parsed: parseDismissed(JSON.stringify(['a', 1, '', 'b'])), broken: parseDismissed('{'), none: parseDismissed(null),
			// 覚える鍵は短い形（questionItemId の JSON ではない）
			key: dismissKey(question('call_abc', 2)),
		}).toEqual({ limit: 200, length: 200, first: 'id3', last: 'id202', reAdd: ['b', 'a'], parsed: ['a', 'b'], broken: [], none: [], key: 'call_abc:2' });
	});

	test('saves dismissed questions so that they stay closed after a restart, merging what was saved before', async () => {
		stored.set('asyncQuestionDismissed', JSON.stringify(['saved:0']));
		useAsyncQuestionDrafts.getState().dismiss([question('new', 1)]);
		await vi.waitFor(() => expect(JSON.parse(stored.get('asyncQuestionDismissed') ?? '[]')).toEqual(['saved:0', 'new:1']));
		expect(useAsyncQuestionDrafts.getState().dismissed).toEqual(['saved:0', 'new:1']);
	});
});
