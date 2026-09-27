// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { afterEach, describe, expect, test } from 'vitest';
import { resetDetailColumnFor, useDetailColumn } from './detailColumn.js';

function snapshot() {
	return useDetailColumn.getState().entries.map(({ key, pcId, open }) => ({ key, pcId, open }));
}

afterEach(() => {
	useDetailColumn.setState({ entries: [] });
});

describe('detailColumn', () => {
	test('PC の画面が2枚積まれ、上が外れると、下の列が積まれる前の状態のまま前面に戻る', () => {
		const pops: string[] = [];
		const { attach, setOpen } = useDetailColumn.getState();
		attach('a', 'pc-a', () => pops.push('a'));
		setOpen('a', true);
		const detachB = attach('b', 'pc-b', () => pops.push('b'));
		setOpen('b', true);
		// 上（B）の列の様子は下（A）を上書きしない。
		setOpen('b', false);
		const whileStacked = snapshot();

		detachB();
		resetDetailColumnFor('pc-b');
		resetDetailColumnFor('pc-a');

		expect({ whileStacked, afterDetach: snapshot(), pops }).toEqual({
			whileStacked: [{ key: 'a', pcId: 'pc-a', open: true }, { key: 'b', pcId: 'pc-b', open: false }],
			afterDetach: [{ key: 'a', pcId: 'pc-a', open: true }],
			// 外れた B には届かず、前面に戻った A の列だけが根まで戻る。
			pops: ['a'],
		});
	});

	test('入れ替えは前面の列にだけ効く（下に隠れた同じ PC の列は触らない）', () => {
		const pops: string[] = [];
		const { attach } = useDetailColumn.getState();
		attach('a1', 'pc-a', () => pops.push('a1'));
		attach('b', 'pc-b', () => pops.push('b'));
		resetDetailColumnFor('pc-a');
		attach('a2', 'pc-a', () => pops.push('a2'));
		resetDetailColumnFor('pc-a');
		expect(pops).toEqual(['a2']);
	});

	test('作り直されずに最前面へ並べ替えられた器は、前に来た時点で前面になり、入れ替えもそこへ効く', () => {
		// 器を積む Stack が [B, A] → [A, B] に並べ替えても、根の attach は走り直さない。
		const pops: string[] = [];
		const { attach, bringToFront } = useDetailColumn.getState();
		attach('b', 'pc-b', () => pops.push('b'));
		attach('a', 'pc-a', () => pops.push('a'));
		bringToFront('b');
		resetDetailColumnFor('pc-b');
		resetDetailColumnFor('pc-a');
		bringToFront('missing');
		expect({ order: snapshot().map(entry => entry.key), pops }).toEqual({ order: ['a', 'b'], pops: ['b'] });
	});

	test('同じ印で置き直した後に古い方を外しても、新しい方は残る', () => {
		const { attach } = useDetailColumn.getState();
		const detachOld = attach('a', 'pc-a', () => {});
		attach('a', 'pc-a', () => {});
		detachOld();
		expect(snapshot()).toEqual([{ key: 'a', pcId: 'pc-a', open: false }]);
	});
});
