// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { AGENT_LIVE_APPEND_ENCODING, AGENT_LIVE_APPEND_V2_ENCODING, applyAgentLiveAppendPatch } from './agentLivePatch.js';

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
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, append: 'x'.repeat(64 * 1024) })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, textOffset: 0 })).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, { ...valid, textOffset: 1.5 })).toBeUndefined();
		expect(applyAgentLiveAppendPatch({ ...live, phase: 'tool' }, 7, valid)).toBeUndefined();
		expect(applyAgentLiveAppendPatch(undefined, 7, valid)).toBeUndefined();
		expect(applyAgentLiveAppendPatch(live, 7, null)).toBeUndefined();
	});

	it('v2: grows past 6,000 chars and follows the window when the PC drops the head', () => {
		expect(AGENT_LIVE_APPEND_V2_ENCODING).toBe('agent-live-append-v2');
		const long = { ...live, text: 'a'.repeat(6_000) };
		const grown = applyAgentLiveAppendPatch(long, 1, { baseRevision: 1, revision: 2, source: 'codex-daemon', startedAt: 10, updatedAt: 30, append: 'bcd' });
		const window = { ...live, text: 'abcdef', textOffset: 100 };
		expect({
			grown: grown?.live.text?.length,
			slid: applyAgentLiveAppendPatch(window, 3, { baseRevision: 3, revision: 4, source: 'codex-daemon', startedAt: 10, updatedAt: 40, append: 'gh', textOffset: 103 }),
			behind: applyAgentLiveAppendPatch(window, 3, { baseRevision: 3, revision: 4, source: 'codex-daemon', startedAt: 10, updatedAt: 40, append: 'gh', textOffset: 99 }),
			beyond: applyAgentLiveAppendPatch(window, 3, { baseRevision: 3, revision: 4, source: 'codex-daemon', startedAt: 10, updatedAt: 40, append: 'gh', textOffset: 109 }),
		}).toEqual({
			grown: 6_003,
			slid: { live: { ...live, updatedAt: 40, text: 'defgh', textOffset: 103 }, liveRevision: 4 },
			behind: undefined,
			beyond: undefined,
		});
	});
});
