import { describe, expect, it } from 'vitest';
import { AGENT_LIVE_APPEND_ENCODING, applyAgentLiveAppendPatch } from './agentLivePatch.js';

const live = {
	phase: 'message' as const,
	source: 'codex-daemon' as const,
	startedAt: 10,
	updatedAt: 20,
	text: '日本🙂',
};

describe('agent live append patch', () => {
	it('advertises the exact encoding and applies a consecutive Unicode append losslessly', () => {
		expect(AGENT_LIVE_APPEND_ENCODING).toBe('agent-live-append-v1');
		expect(applyAgentLiveAppendPatch(live, 7, {
			baseRevision: 7,
			revision: 8,
			source: 'codex-daemon',
			startedAt: 10,
			updatedAt: 30,
			append: '追記🌏',
		})).toEqual({
			live: { ...live, updatedAt: 30, text: '日本🙂追記🌏' },
			liveRevision: 8,
		});
	});

	it('applies a final-only update without changing the text', () => {
		expect(applyAgentLiveAppendPatch(live, 8, {
			baseRevision: 8,
			revision: 9,
			source: 'codex-daemon',
			startedAt: 10,
			updatedAt: 40,
			append: '',
			final: true,
		})).toEqual({
			live: { ...live, updatedAt: 40, final: true },
			liveRevision: 9,
		});
	});

	it('rejects revision gaps, identity changes, malformed values, and oversized results', () => {
		const valid = { baseRevision: 7, revision: 8, source: 'codex-daemon', startedAt: 10, updatedAt: 30, append: 'x' };
		expect(applyAgentLiveAppendPatch(live, 6, valid)).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, revision: 9 })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, source: 'hook' })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, startedAt: 11 })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, final: false })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, extra: true })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, append: 'x'.repeat(6_001) })).toBeUndefined();
		expect(applyAgentLiveAppendPatch({ ...live, phase: 'tool' }, 7, valid)).toBeUndefined();
		expect(applyAgentLiveAppendPatch(undefined, 7, valid)).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, null)).toBeUndefined();
	});
});
