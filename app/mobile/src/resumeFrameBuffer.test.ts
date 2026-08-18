// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import type { Frame } from '@para/protocol';
import { RESUME_BUFFER_MAX_FRAMES, RESUME_BUFFER_TTL_MS, ResumeFrameBuffer } from './resumeFrameBuffer.js';

/**
 * 預かりの境目を固定するテスト。本質は「溢れたら1件も再生しない」こと。
 * 部分的に流すと画面は更新されたように見えて中身に穴が空き、しかもそれが分からない。
 */

function frame(ch: Frame['ch'], seq: number, bytes = 8): Frame {
	return { ch, seq, payload: new Uint8Array(bytes) };
}

describe('ResumeFrameBuffer', () => {
	test('ライブ系だけを預かり、届いた順に返す', () => {
		const buffer = new ResumeFrameBuffer();
		buffer.push(frame('agent', 1));
		buffer.push(frame('scm', 2));
		buffer.push(frame('term', 3));
		const drained = buffer.drain();
		expect({
			order: drained.frames.map(f => [f.ch, f.seq]),
			overflowed: drained.overflowed,
			emptiedAfterDrain: buffer.size,
		}).toEqual({
			order: [['agent', 1], ['term', 3]],
			overflowed: false,
			emptiedAfterDrain: 0,
		});
	});

	test('件数の上限を超えたら、預かりを捨てて overflowed を返す（再生させない）', () => {
		const buffer = new ResumeFrameBuffer();
		for (let seq = 0; seq <= RESUME_BUFFER_MAX_FRAMES; seq++) {
			buffer.push(frame('agent', seq));
		}
		expect(buffer.drain()).toEqual({ frames: [], overflowed: true });
	});

	test('バイトの上限を超えた場合も同じ（1件が大きいケース）', () => {
		const buffer = new ResumeFrameBuffer();
		buffer.push(frame('term', 1, 400 * 1024));
		buffer.push(frame('term', 2, 400 * 1024));
		expect(buffer.drain()).toEqual({ frames: [], overflowed: true });
	});

	test('古すぎるフレームが1件でもあれば全体を捨てる（連続性を保証できないため）', () => {
		let now = 1_000;
		const buffer = new ResumeFrameBuffer(() => now);
		buffer.push(frame('agent', 1));
		now += RESUME_BUFFER_TTL_MS + 1;
		buffer.push(frame('agent', 2));
		expect(buffer.drain()).toEqual({ frames: [], overflowed: true });
	});

	test('drain と clear で溢れの記録ごと元に戻る（次の復帰に持ち越さない）', () => {
		const buffer = new ResumeFrameBuffer();
		for (let seq = 0; seq <= RESUME_BUFFER_MAX_FRAMES; seq++) {
			buffer.push(frame('agent', seq));
		}
		buffer.clear();
		buffer.push(frame('notify', 1));
		expect(buffer.drain()).toEqual({ frames: [frame('notify', 1)], overflowed: false });
	});
});
