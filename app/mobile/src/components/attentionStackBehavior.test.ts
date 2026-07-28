// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import {
	CLOSED_ATTENTION,
	reconcileAttention,
	sortWaiting,
	toggleAttention,
	visibleWaiting,
	type AttentionOpenState,
} from './attentionStackBehavior.js';

const wait = (terminalKey: string, agentStatus = 'question') => ({ terminalKey, agentStatus });
const keys = (items: readonly { terminalKey: string }[]) => items.map(item => item.terminalKey);

describe('sortWaiting', () => {
	it('許可の確認を先に、同種は渡された順のまま並べる', () => {
		expect(keys(sortWaiting([wait('a'), wait('b', 'permission'), wait('c'), wait('d', 'permission')])))
			.toEqual(['b', 'd', 'a', 'c']);
	});
});

describe('reconcileAttention', () => {
	it('新しく現れた1件は自動で開く', () => {
		expect(reconcileAttention(CLOSED_ATTENTION, ['a'])).toEqual({ openKey: 'a', seenKeys: ['a'] });
	});

	it('2件以上では自動で開かない', () => {
		expect(reconcileAttention(CLOSED_ATTENTION, ['a', 'b'])).toEqual({ openKey: undefined, seenKeys: ['a', 'b'] });
	});

	it('開いている行は顔ぶれが増えてもそのまま維持する', () => {
		expect(reconcileAttention({ openKey: 'a', seenKeys: ['a'] }, ['a', 'b', 'c']))
			.toEqual({ openKey: 'a', seenKeys: ['a', 'b', 'c'] });
	});

	it('回答して残り1件になっても、その1件を勝手に開かない（指の下で次の許可が開くのを防ぐ）', () => {
		// a を開いて回答 → a が消えて b だけが残る
		expect(reconcileAttention({ openKey: 'a', seenKeys: ['a', 'b'] }, ['b']))
			.toEqual({ openKey: undefined, seenKeys: ['b'] });
	});

	it('回答して2件以上残っても、次を自動では開かない', () => {
		expect(reconcileAttention({ openKey: 'a', seenKeys: ['a', 'b', 'c'] }, ['b', 'c']))
			.toEqual({ openKey: undefined, seenKeys: ['b', 'c'] });
	});

	it('回答したのと同じ更新で新しい1件が届いても開かない（指の下にカードを出さない）', () => {
		// a を開いて回答 → 同じスナップショットで a が消え、未知の b が現れる
		expect(reconcileAttention({ openKey: 'a', seenKeys: ['a'] }, ['b']))
			.toEqual({ openKey: undefined, seenKeys: ['b'] });
	});

	it('絞り込みで一時的に消えても「見たことがある」記録は残す（切り替えて戻すだけで開かない）', () => {
		// 畳んである a が、ワークスペース絞り込みで表示対象から外れて戻ってくる
		const filtered = reconcileAttention({ openKey: undefined, seenKeys: ['a'] }, [], ['a']);
		expect([filtered, reconcileAttention(filtered, ['a'], ['a'])])
			.toEqual([{ openKey: undefined, seenKeys: ['a'] }, { openKey: undefined, seenKeys: ['a'] }]);
	});

	it('自分で畳んだ1件は開き直さない（もう一度タップするまで畳んだまま）', () => {
		const closed = toggleAttention({ openKey: 'a', seenKeys: ['a'] }, 'a');
		expect([closed, reconcileAttention(closed, ['a'])])
			.toEqual([{ openKey: undefined, seenKeys: ['a'] }, { openKey: undefined, seenKeys: ['a'] }]);
	});

	it('いったん居なくなった相手が戻ってきたら、また新しい1件として開く', () => {
		const empty = reconcileAttention({ openKey: undefined, seenKeys: ['a'] }, []);
		expect([empty, reconcileAttention(empty, ['a'])])
			.toEqual([{ openKey: undefined, seenKeys: [] }, { openKey: 'a', seenKeys: ['a'] }]);
	});

	it('変化が無ければ同じ状態をそのまま返す（無駄な再描画を起こさない）', () => {
		const state: AttentionOpenState = { openKey: 'a', seenKeys: ['a', 'b'] };
		expect(reconcileAttention(state, ['a', 'b'])).toBe(state);
	});
});

describe('toggleAttention', () => {
	it('別の行を開くと前の行は閉じる', () => {
		expect(toggleAttention({ openKey: 'a', seenKeys: ['a', 'b'] }, 'b')).toEqual({ openKey: 'b', seenKeys: ['a', 'b'] });
	});
});

describe('visibleWaiting', () => {
	const items = [wait('a'), wait('b'), wait('c'), wait('d'), wait('e')];

	it('既定は先頭3件までに抑える', () => {
		expect(keys(visibleWaiting(items, undefined, false))).toEqual(['a', 'b', 'c']);
	});

	it('開いている行が範囲外なら必ず含める', () => {
		expect(keys(visibleWaiting(items, 'e', false))).toEqual(['a', 'b', 'c', 'e']);
	});

	it('すべて表示中は並び順のまま全件返す', () => {
		expect(keys(visibleWaiting(items, undefined, true))).toEqual(['a', 'b', 'c', 'd', 'e']);
	});
});
