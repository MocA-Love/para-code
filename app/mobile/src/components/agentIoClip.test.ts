// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { clipForDisplay } from './agentIoClip.js';

describe('clipForDisplay', () => {
	test('returns the body unclipped when under both limits', () => {
		const body = 'line one\nline two';
		expect(clipForDisplay(body)).toEqual({ text: body, omittedLines: 0 });
	});

	test('clips by line count and reports the omitted lines', () => {
		const lines = Array.from({ length: 510 }, (_, i) => `line ${i}`);
		const body = lines.join('\n');
		const clipped = clipForDisplay(body);
		expect(clipped.text).toBe(lines.slice(0, 500).join('\n'));
		expect(clipped.omittedLines).toBe(10);
	});

	// 改行無しの巨大1行（minified JSON等）は行数では1行しか減らないため、文字数上限だけで
	// 切れた場合を別カウントで拾う必要がある。ここが漏れると省略表示なしで黙って切れる。
	test('clips a single huge line by char count and still reports an omission', () => {
		const body = 'x'.repeat(25_000);
		const clipped = clipForDisplay(body);
		expect(clipped.text).toBe('x'.repeat(20_000));
		expect(clipped.omittedLines).toBe(1);
	});

	test('clips by both line count and char count without double-counting the char omission', () => {
		const lines = Array.from({ length: 510 }, () => 'x'.repeat(100));
		const body = lines.join('\n');
		const clipped = clipForDisplay(body);
		expect(clipped.text.length).toBe(20_000);
		// 行数超過で既に10行分を数えているので、文字数上限で追加で切れても+1は足さない。
		expect(clipped.omittedLines).toBe(10);
	});

	test('does not clip when exactly at the line limit', () => {
		const lines = Array.from({ length: 500 }, () => 'x');
		const body = lines.join('\n');
		expect(clipForDisplay(body)).toEqual({ text: body, omittedLines: 0 });
	});
});
