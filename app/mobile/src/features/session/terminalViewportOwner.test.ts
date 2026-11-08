// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { createTerminalViewportOwnership } from './terminalViewportOwner.js';

describe('terminalViewportOwner', () => {
	test('a pane withdraws the viewport only while it is the last one that set it', () => {
		const applied: (string | undefined)[] = [];
		const ownership = createTerminalViewportOwnership<string>(viewport => applied.push(viewport));
		const a = {};
		const b = {};
		ownership.claim(a, 'a');
		// タブを A → B へ替えた: B が先に申告してから A が隠れても、B の申告は消さない
		ownership.claim(b, 'b');
		ownership.release(a);
		// 会話の表示へ替えた: 出ているペインが無くなったら取り下げる
		ownership.release(b);
		ownership.release(b);
		expect(applied).toEqual(['a', 'b', undefined]);
	});

	test('when the later pane goes away first, the pane still shown gets its viewport back', () => {
		const applied: (string | undefined)[] = [];
		const ownership = createTerminalViewportOwnership<string>(viewport => applied.push(viewport));
		const a = {};
		const b = {};
		ownership.claim(a, 'a');
		ownership.claim(b, 'b');
		// 後から出た B が先に隠れても、まだ出ている A の申告に戻す
		ownership.release(b);
		ownership.release(a);
		expect(applied).toEqual(['a', 'b', 'a', undefined]);
	});
});
