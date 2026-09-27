// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { routes } from '../../routes.js';
import { pcTargetOf, planPcOpen, type NavRouteLike, type NavStateLike, type PcOpenPlan } from './pcOpenPlan.js';

/** PC の器。`screens` は器の中の Stack（最後が前面）。 */
function pc(key: string, pcId: string, screens: readonly NavRouteLike[]): NavRouteLike {
	return { key, name: '[pcId]', params: { pcId }, state: { key: `${key}-inner`, index: screens.length - 1, routes: screens } };
}

function session(key: string, pcId: string, spaceId: string, tab?: string, latest?: string): NavRouteLike {
	return { key, name: 'session/[spaceId]', params: { pcId, spaceId, ...(tab !== undefined ? { tab } : {}), ...(latest !== undefined ? { latest } : {}) } };
}

const index = (key: string): NavRouteLike => ({ key, name: 'index', params: {} });

function root(pcs: readonly NavRouteLike[], overlay?: string): NavStateLike {
	const routesAbove: NavRouteLike[] = overlay !== undefined ? [{ key: 'overlay', name: overlay }] : [];
	const all: NavRouteLike[] = [
		{ key: 'home', name: 'index' },
		{ key: 'pcs', name: 'pc', state: { key: 'pc-stack', index: pcs.length - 1, routes: pcs } },
		...routesAbove,
	];
	return { key: 'root', index: all.length - 1, routes: all };
}

/** 器の Stack の中で開く計画（書かなかった項目は「しない」）。 */
function inStack(plan: Partial<Extract<PcOpenPlan, { kind: 'in-stack' }>>): PcOpenPlan {
	return { kind: 'in-stack', closeOverlay: undefined, popPcs: undefined, popInner: undefined, setParams: undefined, push: false, ...plan };
}

const target = (pcId: string, spaceId: string, tab?: string) => pcTargetOf(routes.session(pcId, spaceId, tab !== undefined ? { tab: { kind: 'terminal', terminalKey: tab } } : {}))!;

describe('pcTargetOf', () => {
	test('routes の形と、中継の画面が受け取る文字列の形を同じ行き先として読む', () => {
		expect([
			pcTargetOf(routes.session('pc-a', '1:w1', { tab: { kind: 'terminal', terminalKey: 't1' }, latest: 'x' })),
			pcTargetOf('/pc/pc-a/session/1%3Aw1?tab=terminal%3At1&latest=x'),
			pcTargetOf(routes.pc('pc-a')),
			pcTargetOf('/pc/pc-a/'),
			pcTargetOf('/settings'),
		]).toEqual([
			{ pcId: 'pc-a', path: '/pc/pc-a/session/1:w1', tab: 'terminal:t1', latest: 'x' },
			{ pcId: 'pc-a', path: '/pc/pc-a/session/1:w1', tab: 'terminal:t1', latest: 'x' },
			{ pcId: 'pc-a', path: '/pc/pc-a', tab: undefined, latest: undefined },
			{ pcId: 'pc-a', path: '/pc/pc-a', tab: undefined, latest: undefined },
			undefined,
		]);
	});
});

describe('planPcOpen', () => {
	const stackAB = root([pc('a', 'pc-a', [index('a0'), session('a1', 'pc-a', 'w1')]), pc('b', 'pc-b', [index('b0'), session('b1', 'pc-b', 'w2')])]);

	test('前面の器と同じ PC: 同じ画面なら何もしない、違う画面ならその中で開く', () => {
		expect([
			planPcOpen(stackAB, target('pc-b', 'w2'), 'focus'),
			planPcOpen(stackAB, target('pc-b', 'w3'), 'focus'),
			planPcOpen(stackAB, target('pc-b', 'w2', 't9'), 'focus'),
		]).toEqual([
			inStack({}),
			inStack({ push: true }),
			inStack({ push: true }),
		]);
	});

	test('下に積んだ器と同じ PC: 上の器を閉じてそこへ戻る（並べ替えない）。器の Stack は伸びない', () => {
		expect([
			planPcOpen(stackAB, target('pc-a', 'w1'), 'focus'),
			planPcOpen(stackAB, target('pc-a', 'w5'), 'focus'),
		]).toEqual([
			inStack({ popPcs: { stackKey: 'pc-stack', count: 1 } }),
			inStack({ popPcs: { stackKey: 'pc-stack', count: 1 }, push: true }),
		]);
	});

	test('コンテナの状態が Expo Router の `__root` に包まれていても、中のルートの Stack を見る', () => {
		const wrapped: NavStateLike = { key: 'container', index: 0, routes: [{ key: 'r', name: '__root', state: stackAB }] };
		expect(planPcOpen(wrapped, target('pc-a', 'w5'), 'focus')).toEqual(inStack({ popPcs: { stackKey: 'pc-stack', count: 1 }, push: true }));
	});

	test('行き先が PC の画面（器の根）: 根を積まずに器の中を根まで戻す（下に積んだ器でも同じ）', () => {
		const onlyRoot = root([pc('a', 'pc-a', [index('a0')])]);
		expect([
			planPcOpen(stackAB, pcTargetOf(routes.pc('pc-b'))!, 'focus', true),
			planPcOpen(stackAB, pcTargetOf(routes.pc('pc-a'))!, 'focus'),
			planPcOpen(onlyRoot, pcTargetOf(routes.pc('pc-a'))!, 'focus'),
		]).toEqual([
			inStack({ popInner: { stackKey: 'b-inner' } }),
			inStack({ popPcs: { stackKey: 'pc-stack', count: 1 }, popInner: { stackKey: 'a-inner' } }),
			inStack({}),
		]);
	});

	test('同じ画面に `latest` が付いてきたら、開き直さずにその画面へ渡す（同じ印なら何もしない）', () => {
		const shownWithLatest = root([pc('a', 'pc-a', [index('a0'), session('a1', 'pc-a', 'w1', undefined, 'old')])]);
		const latest = (value: string) => pcTargetOf(routes.session('pc-a', 'w1', { latest: value }))!;
		expect([
			planPcOpen(shownWithLatest, latest('new'), 'focus'),
			planPcOpen(shownWithLatest, latest('old'), 'focus'),
		]).toEqual([
			inStack({ setParams: { stackKey: 'a-inner', routeKey: 'a1', params: { latest: 'new' } } }),
			inStack({}),
		]);
	});

	test('2列で同じ PC の別の画面: 詳細の列を根まで戻してから開く（1列では積む）', () => {
		expect([
			planPcOpen(stackAB, target('pc-b', 'w3'), 'focus', true),
			planPcOpen(stackAB, target('pc-b', 'w3'), 'focus', false),
			planPcOpen(stackAB, target('pc-a', 'w5'), 'focus', true),
		]).toEqual([
			inStack({ popInner: { stackKey: 'b-inner' }, push: true }),
			inStack({ push: true }),
			inStack({ popPcs: { stackKey: 'pc-stack', count: 1 }, popInner: { stackKey: 'a-inner' }, push: true }),
		]);
	});

	test('器の Stack に無い PC: 上に新しい器を積む', () => {
		expect(planPcOpen(stackAB, target('pc-c', 'w1'), 'focus')).toEqual(inStack({ push: true }));
	});

	test('中継の画面・通知の一覧から: 自分を閉じてから、すぐ下の器の Stack に同じ規則を当てる', () => {
		const withRelay = root([pc('a', 'pc-a', [index('a0'), session('a1', 'pc-a', 'w1')])], 'open-session');
		expect([
			planPcOpen(withRelay, target('pc-a', 'w1'), 'overlay'),
			planPcOpen(withRelay, target('pc-b', 'w2'), 'overlay'),
		]).toEqual([
			inStack({ closeOverlay: { rootKey: 'root' } }),
			inStack({ closeOverlay: { rootKey: 'root' }, push: true }),
		]);
	});

	test('器の Stack が前面・すぐ下に無い（ホーム・設定から）: 今までどおり新しい器の Stack を積む', () => {
		const onHome: NavStateLike = { key: 'root', index: 0, routes: [{ key: 'home', name: 'index' }] };
		const settingsOverPcs = root([pc('a', 'pc-a', [index('a0')])], 'settings');
		const relayOverHome: NavStateLike = { key: 'root', index: 1, routes: [{ key: 'home', name: 'index' }, { key: 'relay', name: 'open-session' }] };
		expect([
			planPcOpen(onHome, target('pc-a', 'w1'), 'focus'),
			planPcOpen(settingsOverPcs, target('pc-a', 'w1'), 'focus'),
			planPcOpen(relayOverHome, target('pc-a', 'w1'), 'overlay'),
		]).toEqual([{ kind: 'new-stack' }, { kind: 'new-stack' }, { kind: 'new-stack' }]);
	});
});
