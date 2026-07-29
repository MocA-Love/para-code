// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { AgentStickyScroll, type IAgentScrollSample } from './agentStickyScroll.js';

const VIEWPORT = 800;

/** 下端に張り付いた状態のサンプル。 */
function atBottom(contentHeight: number): IAgentScrollSample {
	return { offsetY: contentHeight - VIEWPORT, layoutHeight: VIEWPORT, contentHeight };
}

function at(offsetY: number, contentHeight: number): IAgentScrollSample {
	return { offsetY, layoutHeight: VIEWPORT, contentHeight };
}

/** 応答が流れている状態を作る（下端に居るところから始める）。 */
function streaming(): AgentStickyScroll {
	const scroll = new AgentStickyScroll();
	scroll.handleContentSize(2_000);
	scroll.handleScroll(atBottom(2_000));
	return scroll;
}

describe('AgentStickyScroll', () => {
	it('follows the end while the reader stays at the bottom', () => {
		const scroll = streaming();
		expect(scroll.handleContentSize(2_200)).toBe(true);
		scroll.handleScroll(atBottom(2_200));
		expect(scroll.sticky).toBe(true);
	});

	it('stops following as soon as the reader scrolls up, even after the finger is lifted', () => {
		// これが今回直した本体。以前は「指が触れている間に届いた onScroll」でしか解除できず、
		// 指を離した後に届くイベント（本文が伸びたことで発火する分）では解除できなかった。
		const scroll = streaming();
		scroll.beginDrag();
		scroll.handleScroll(at(1_000, 2_000));
		scroll.endDrag();
		// 慣性が始まらないまま指が離れ、以降のイベントはフラグが落ちた状態で届く。
		expect(scroll.sticky).toBe(false);
		expect(scroll.handleContentSize(2_400)).toBe(false);
	});

	it('stops following even when the scroll up is smaller than the bottom threshold', () => {
		// 応答が伸びれば数チャンクで 80px は超える。ここで残すと「少し上げただけで引き戻される」になる。
		const scroll = streaming();
		scroll.handleScroll(at(2_000 - VIEWPORT - 20, 2_000));
		expect(scroll.sticky).toBe(false);
		expect(scroll.handleContentSize(2_100)).toBe(false);
	});

	it('does not resume following just because the reader happens to sit near the bottom', () => {
		const scroll = streaming();
		scroll.handleScroll(at(2_000 - VIEWPORT - 20, 2_000));
		expect(scroll.sticky).toBe(false);
		// 位置が動かないサンプルが続いても、解除は取り消されない。
		scroll.handleScroll(at(2_000 - VIEWPORT - 20, 2_000));
		expect(scroll.sticky).toBe(false);
	});

	it('resumes following when the reader scrolls back down to the end', () => {
		const scroll = streaming();
		scroll.handleScroll(at(500, 2_000));
		expect(scroll.sticky).toBe(false);
		scroll.handleScroll(atBottom(2_000));
		expect(scroll.sticky).toBe(true);
		expect(scroll.handleContentSize(2_100)).toBe(true);
	});

	it('ignores the offset the OS trims when the content shrinks', () => {
		// ライブ表示のフッターが畳まれると contentHeight が縮み、offset も切り詰められる。
		// これを「上へスクロールした」と数えると、何もしていないのに追従が切れる。
		const scroll = streaming();
		scroll.handleScroll(at(1_200, 2_000));
		scroll.handleScroll(atBottom(2_000));
		expect(scroll.sticky).toBe(true);
		scroll.handleScroll(atBottom(1_500));
		expect(scroll.sticky).toBe(true);
	});

	it('does not fight the finger while a drag or its momentum is running', () => {
		const scroll = streaming();
		scroll.beginDrag();
		expect(scroll.handleContentSize(2_200)).toBe(false);
		scroll.endDrag();
		scroll.beginMomentum();
		expect(scroll.handleContentSize(2_400)).toBe(false);
		scroll.endMomentum();
	});

	it('never follows a shrinking content height', () => {
		const scroll = streaming();
		expect(scroll.handleContentSize(1_800)).toBe(false);
		expect(scroll.sticky).toBe(true);
	});

	it('follows again after the reader asks for the latest message', () => {
		const scroll = streaming();
		scroll.handleScroll(at(400, 2_000));
		expect(scroll.sticky).toBe(false);
		scroll.followNow();
		expect(scroll.sticky).toBe(true);
		expect(scroll.handleContentSize(2_100)).toBe(true);
	});

	it('chases the end for a navigation that asked for a specific entry, even after the reader scrolls up', () => {
		// 通知から開いた直後は FlatList が分割描画で伸びていくので、下端に届くまで追いかけ続ける。
		const scroll = new AgentStickyScroll();
		scroll.followFromNavigation();
		scroll.handleScroll(at(4_000, 5_000));
		scroll.handleScroll(at(3_000, 5_000));
		// 追いかけている間は「最新へジャンプ」を出さない（すぐ消えるボタンが点滅して見える）。
		expect(scroll.sticky).toBe(true);
		expect(scroll.handleContentSize(6_000)).toBe(true);
		// 下端まで届いたら追いかけを終える。
		scroll.handleScroll(atBottom(6_000));
		expect(scroll.sticky).toBe(true);
	});

	it('hands the chase over to the reader the moment they touch the list', () => {
		const scroll = new AgentStickyScroll();
		scroll.followFromNavigation();
		scroll.handleScroll(at(4_000, 5_000));
		scroll.beginDrag();
		scroll.handleScroll(at(3_000, 5_000));
		scroll.endDrag();
		expect(scroll.sticky).toBe(false);
		expect(scroll.handleContentSize(6_000)).toBe(false);
	});

	it('keeps following when the reader bounces the list at the very end', () => {
		// iOS のラバーバンド。下端で下へ引くと offsetY は最大値を超え、離すとそこへ戻る。
		// 戻る過程は「上へ動いた」ように見えるが操作ではない。
		const scroll = streaming();
		scroll.handleScroll(at(2_000 - VIEWPORT + 60, 2_000));
		scroll.handleScroll(at(2_000 - VIEWPORT + 20, 2_000));
		scroll.handleScroll(atBottom(2_000));
		expect(scroll.sticky).toBe(true);
	});

	it('keeps following when closing the keyboard grows the viewport', () => {
		// 末尾に居るとき、表示領域が伸びると OS は offsetY を新しい最大値まで切り詰める。
		// キーボードの高さぶん一気に減るので、差分だけを見ると操作と見分けがつかない。
		const scroll = streaming();
		scroll.handleScroll({ offsetY: 2_000 - VIEWPORT, layoutHeight: VIEWPORT, contentHeight: 2_000 });
		scroll.handleScroll({ offsetY: 2_000 - (VIEWPORT + 300), layoutHeight: VIEWPORT + 300, contentHeight: 2_000 });
		expect(scroll.sticky).toBe(true);
	});

	it('notices a slow drag that only moves a few pixels per sample', () => {
		// 1サンプルの差だけを見ていると、遡る操作がいくら積み重なっても検知できない。
		const scroll = streaming();
		let offset = 2_000 - VIEWPORT;
		for (let i = 0; i < 10; i++) {
			offset -= 3;
			scroll.handleScroll(at(offset, 2_000));
		}
		expect(scroll.sticky).toBe(false);
	});

	it('does not unstick on a stale offset that arrives after the content grew', () => {
		// 本文が伸びた直後は、古い offset のまま「下端から遠い」サンプルが届く。位置は動いて
		// いないので操作ではない（位置ベースへ戻したことで再発しないことを固定する）。
		const scroll = streaming();
		scroll.handleScroll(at(2_000 - VIEWPORT, 4_000));
		expect(scroll.sticky).toBe(true);
	});

	it('resumes following from just outside the bottom threshold', () => {
		// しきい値そのものを固定する（下端から 40px なら「最下部にいる」側）。
		const scroll = streaming();
		scroll.handleScroll(at(1_000, 2_000));
		expect(scroll.sticky).toBe(false);
		scroll.handleScroll(at(2_000 - VIEWPORT - 40, 2_000));
		expect(scroll.sticky).toBe(true);
	});

	it('resumes following when the content shrinks until the reader is back at the end', () => {
		// 遡って読んでいる間にライブ表示が畳まれ、末尾まで切り詰められた。位置は動かしていないが、
		// 実際に末尾に居るので追従へ戻す（「最新へジャンプ」を出したままにしない）。
		const scroll = streaming();
		scroll.handleScroll(at(900, 2_000));
		expect(scroll.sticky).toBe(false);
		scroll.handleScroll(at(500, 1_300));
		expect(scroll.sticky).toBe(true);
	});

	it('does not resume when the reader stops just short of the end', () => {
		// 下端の手前で止めたら追従は再開しない（再開は末尾に着いたときか、下端付近で下向きに
		// 動いているとき）。ここを「下端付近なら再開」にすると、遡り読みの途中で勝手に戻る。
		const scroll = streaming();
		scroll.handleScroll(at(400, 2_000));
		expect(scroll.sticky).toBe(false);
		// まず下端のしきい値より下で起点を降ろす。
		for (let offset = 500; offset <= 1_100; offset += 20) {
			scroll.handleScroll(at(offset, 2_000));
		}
		expect(scroll.sticky).toBe(false);
		// そこから 2px 刻み（＝下向きの動きとは数えない幅）でしきい値をまたいで止まる。
		for (let offset = 1_102; offset <= 1_160; offset += 2) {
			scroll.handleScroll(at(offset, 2_000));
		}
		expect(scroll.sticky).toBe(false);
	});

	it('does not carry an overscroll peak into the anchor', () => {
		// iOS のバウンスで offsetY は末尾を超える。その頂点を起点として覚えてしまうと、
		// 本文が伸びて末尾から離れた瞬間に「上へ動いた」と誤判定して追従が切れる。
		const scroll = streaming();
		scroll.handleScroll(at(1_260, 2_000));
		scroll.handleScroll(at(1_200, 2_600));
		expect(scroll.sticky).toBe(true);
	});

	it('forgets the previous target when the screen switches terminals', () => {
		const scroll = streaming();
		scroll.handleScroll(at(200, 2_000));
		expect(scroll.sticky).toBe(false);
		scroll.reset();
		expect(scroll.sticky).toBe(true);
		// 長いチャットから短いチャットへ移っても「縮んだ」と誤判定しない。
		expect(scroll.handleContentSize(600)).toBe(true);
	});

	it('re-pins the end when the viewport shrinks under the keyboard, but not while reading back', () => {
		const scroll = streaming();
		expect(scroll.shouldPinOnViewportShrink()).toBe(true);
		scroll.handleScroll(at(300, 2_000));
		expect(scroll.shouldPinOnViewportShrink()).toBe(false);
	});
});
