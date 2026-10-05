// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { RtcStatLike } from './browserRoute.js';
import { INITIAL_VIDEO_HEALTH, VIDEO_STALL_MS, framesDecodedFromStats, nextVideoHealth } from './browserVideoHealth.js';

describe('browserVideoHealth', () => {
	test('受けている映像の inbound-rtp だけからフレーム数を読む', () => {
		const stats: RtcStatLike[] = [
			{ id: 'a', type: 'inbound-rtp', kind: 'audio', framesDecoded: 99 },
			{ id: 'v', type: 'inbound-rtp', kind: 'video', framesDecoded: 12 },
			{ id: 'o', type: 'outbound-rtp', kind: 'video', framesDecoded: 50 },
		];
		expect(framesDecodedFromStats(new Map(stats.map(stat => [stat.id ?? '', stat])))).toBe(12);
		expect(framesDecodedFromStats(new Map())).toBeUndefined();
	});

	test('最初の 1 枚を確かめてから流れているとみなし、増えないまま止まったら流れていないに戻す', () => {
		const zero = nextVideoHealth(INITIAL_VIDEO_HEALTH, 0, 1_000);
		const first = nextVideoHealth(zero, 1, 2_000);
		const still = nextVideoHealth(first, 1, 2_000 + VIDEO_STALL_MS - 1);
		const stalled = nextVideoHealth(still, 1, 2_000 + VIDEO_STALL_MS);
		const again = nextVideoHealth(stalled, 2, 9_000);
		const unreadable = nextVideoHealth(again, undefined, 20_000);
		expect([zero.flowing, first.flowing, still.flowing, stalled.flowing, again.flowing, unreadable.flowing]).toEqual([false, true, true, false, true, true]);
	});
});
