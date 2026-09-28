// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { ConfirmTarget } from './confirmTarget.js';

describe('ConfirmTarget', () => {
	it('シートを閉じた後（ConfirmDrawer は onClose の後に onConfirm を呼ぶ）でも、確定のときに対象を取り出せる', () => {
		const target = new ConfirmTarget<{ number: number }>();
		// 開く → 確定で先に onClose（シートの見え隠れだけを消す）→ 閉じ切った後に onConfirm
		target.hold({ number: 12 });
		const sent: number[] = [];
		const onConfirm = () => {
			const pr = target.take();
			if (pr !== undefined) {
				sent.push(pr.number);
			}
		};
		onConfirm();
		onConfirm();
		expect(sent).toEqual([12]);
	});

	it('開き直したら新しい対象に置き換わる', () => {
		const target = new ConfirmTarget<string>();
		target.hold('a');
		target.hold('b');
		expect([target.take(), target.take()]).toEqual(['b', undefined]);
	});
});
