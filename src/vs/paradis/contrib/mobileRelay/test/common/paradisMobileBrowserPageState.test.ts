/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisResolveMobileBrowserAddress } from '../../common/paradisMobileBrowserAddress.js';
import {
	paradisMobileBrowserHistoryState,
	paradisMobileBrowserLifecycleProgress,
	paradisMobileBrowserPageMessage,
	paradisMobileFocusSelectExpression,
	paradisNormalizeMobileBrowserFocusReport,
	PARADIS_MOBILE_FOCUS_BINDING,
	PARADIS_MOBILE_FOCUS_SCRIPT,
} from '../../common/paradisMobileBrowserPageState.js';
import { PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX, paradisParseMobileBrowserFocus, paradisParseMobileBrowserPage } from '../../common/paradisMobileBrowserProtocol.js';
import {
	paradisIsMobileBrowserTargetId,
	paradisMobileBrowserScopeSignature,
	paradisMobileBrowserTargetsScope,
	paradisMobileBrowserViewsInSpace,
	paradisSanitizeMobileBrowserScopeSnapshot,
} from '../../common/paradisMobileBrowserScope.js';

suite('ParadisMobileBrowserPageState', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('アドレス欄の文字を URL か検索に直す（http(s) だけ）', () => {
		const cases: [unknown, unknown][] = [
			['example.com/docs', undefined],
			['https://example.com/a b', undefined],
			['localhost:5173', undefined],
			['192.168.1.2:8080/x', undefined],
			['devbox', undefined],
			['devbox', 'none'],
			['para code mobile', undefined],
			['para code mobile', 'none'],
			['para code mobile', 'bing'],
			['javascript:alert(1)', undefined],
			['file:///etc/passwd', undefined],
			['ftp://example.com/', undefined],
			['   ', undefined],
			['a\nb', undefined],
			[42, undefined],
		];
		assert.deepStrictEqual(cases.map(([text, engine]) => paradisResolveMobileBrowserAddress(text, engine)), [
			'https://example.com/docs',
			'https://example.com/a%20b',
			'http://localhost:5173/',
			'http://192.168.1.2:8080/x',
			'https://www.google.com/search?q=devbox',
			'http://devbox/',
			'https://www.google.com/search?q=para+code+mobile',
			undefined,
			'https://www.bing.com/search?q=para+code+mobile',
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
		]);
	});

	test('スペースの台帳を確かめ、そのスペースのビューを引く', () => {
		const managed = paradisSanitizeMobileBrowserScopeSnapshot({
			managed: true,
			views: [{ viewId: 'v1', stateKey: 'repo' }, { viewId: 'v2', stateKey: 'worktree:x' }, { viewId: 'v3' }, { viewId: '' }, { viewId: 7 }, null],
		});
		const unmanaged = paradisSanitizeMobileBrowserScopeSnapshot({ managed: false, views: [{ viewId: 'v4' }, { viewId: 'v5', stateKey: 'repo' }] });
		assert.deepStrictEqual({
			managed,
			inRepo: managed && paradisMobileBrowserViewsInSpace(managed, 'repo'),
			inOther: managed && paradisMobileBrowserViewsInSpace(managed, 'nothing'),
			unmanaged: unmanaged && paradisMobileBrowserViewsInSpace(unmanaged, 'repo'),
			invalid: [paradisSanitizeMobileBrowserScopeSnapshot(null), paradisSanitizeMobileBrowserScopeSnapshot({ managed: 'yes', views: [] })],
			// 長い stateKey のビューも台帳から落ちず、そのスペースで引ける
			longKey: paradisMobileBrowserViewsInSpace(paradisSanitizeMobileBrowserScopeSnapshot({ managed: true, views: [{ viewId: 'v9', stateKey: 'k'.repeat(4000) }] })!, 'k'.repeat(4000)),
			sameSignature: managed !== undefined && paradisMobileBrowserScopeSignature(managed) === paradisMobileBrowserScopeSignature({ managed: true, views: [...managed.views].reverse() }),
			scope: [
				paradisMobileBrowserTargetsScope({ windowId: 1, ws: 'repo' }),
				paradisMobileBrowserTargetsScope({}),
				paradisMobileBrowserTargetsScope({ windowId: 1 }),
				paradisMobileBrowserTargetsScope({ windowId: 1.5, ws: 'repo' }),
				// worktree の stateKey は長い（日本語のパスは 1 文字が 9 文字）。台帳と同じ 4096 文字までは絞り、
				// 超えたら全件に戻さず「読めない」を返す。
				paradisMobileBrowserTargetsScope({ windowId: 1, ws: 'x'.repeat(4096) }) !== 'invalid',
				paradisMobileBrowserTargetsScope({ windowId: 1, ws: 'x'.repeat(4097) }),
			],
			targetIds: ['ABCDEF0123456789', 'a-b_c.d', '', '../json', 'x'.repeat(129), 7].map(paradisIsMobileBrowserTargetId),
		}, {
			managed: { managed: true, views: [{ viewId: 'v1', stateKey: 'repo' }, { viewId: 'v2', stateKey: 'worktree:x' }, { viewId: 'v3' }] },
			inRepo: ['v1'],
			inOther: [],
			unmanaged: ['v4', 'v5'],
			invalid: [undefined, undefined],
			longKey: ['v9'],
			sameSignature: true,
			scope: [{ windowId: 1, ws: 'repo' }, undefined, 'invalid', 'invalid', true, 'invalid'],
			targetIds: [true, true, false, false, false, false],
		});
	});

	test('履歴・読み込みの段階・ページの通知の形', () => {
		const history = paradisMobileBrowserHistoryState({ currentIndex: 0, entries: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }] });
		const message = paradisMobileBrowserPageMessage('t1', { url: 'https://a.example/', title: 'A', loading: true, progress: 0.666, canGoBack: false, canGoForward: true });
		assert.deepStrictEqual({
			history,
			broken: [paradisMobileBrowserHistoryState({ currentIndex: 3, entries: [] }), paradisMobileBrowserHistoryState(undefined), paradisMobileBrowserHistoryState({ currentIndex: -1, entries: [{}] })],
			progress: [paradisMobileBrowserLifecycleProgress(0, 'init'), paradisMobileBrowserLifecycleProgress(0.1, 'DOMContentLoaded'), paradisMobileBrowserLifecycleProgress(0.6, 'init'), paradisMobileBrowserLifecycleProgress(0.6, 'load'), paradisMobileBrowserLifecycleProgress(0.6, 'networkIdle')],
			message,
			roundTrip: paradisParseMobileBrowserPage(message),
		}, {
			history: { url: 'https://a.example/', title: 'A', canGoBack: false, canGoForward: true },
			broken: [undefined, undefined, undefined],
			progress: [0.1, 0.6, 0.6, 1, 0.6],
			message: { t: 'page', targetId: 't1', url: 'https://a.example/', title: 'A', loading: true, progress: 0.67, canGoBack: false, canGoForward: true },
			roundTrip: message,
		});
	});

	test('フォーカスの報告を正規化する（パスワードは中身を落とす・長さを切る・タップの直後だけ fromTap）', () => {
		const context = { targetId: 't1', seq: 5, now: 10_000, lastTapAt: 9_500 };
		const report = (value: object, overrides: Partial<typeof context> = {}) => paradisNormalizeMobileBrowserFocusReport(JSON.stringify(value), { ...context, ...overrides });
		const long = 'x'.repeat(PARADIS_MOBILE_BROWSER_FOCUS_VALUE_MAX + 10);
		const results = [
			report({ focused: true, field: 'text', inputType: 'search', value: 'abc', reason: 'focus' }),
			report({ focused: true, field: 'text', inputType: 'search', value: 'abc', reason: 'focus' }, { lastTapAt: 1 }),
			report({ focused: true, field: 'text', inputType: 'password', value: 'secret', reason: 'tap' }),
			report({ focused: true, field: 'textarea', value: long, reason: 'input' }),
			report({ focused: true, field: 'contenteditable', fieldId: 3, value: 'hi', inputType: 'BAD TYPE', reason: 'focus' }, { lastTapAt: 1 }),
			report({ focused: false, reason: 'focus' }),
			report({ focused: true, field: 'select', reason: 'focus' }),
			paradisNormalizeMobileBrowserFocusReport('not json', context),
			paradisNormalizeMobileBrowserFocusReport(42, context),
		];
		assert.deepStrictEqual(results.map(result => result === undefined ? undefined : { ...result, value: result.value?.length === long.length - 10 ? 'long' : result.value }), [
			{ t: 'focus', targetId: 't1', seq: 5, focused: true, field: 'text', inputType: 'search', value: 'abc', fromTap: true },
			{ t: 'focus', targetId: 't1', seq: 5, focused: true, field: 'text', inputType: 'search', value: 'abc' },
			{ t: 'focus', targetId: 't1', seq: 5, focused: true, field: 'text', inputType: 'password', secret: true, value: undefined, fromTap: true },
			{ t: 'focus', targetId: 't1', seq: 5, focused: true, field: 'textarea', value: 'long', truncated: true },
			// contenteditable は中身を送らない（書式を持つので置き換えず、文字を足す方式にする）
			{ t: 'focus', targetId: 't1', seq: 5, focused: true, fieldId: 3, field: 'contenteditable', value: undefined },
			{ t: 'focus', targetId: 't1', seq: 5, focused: false, value: undefined },
			undefined,
			undefined,
			undefined,
		]);
		// アプリの読み方を通っても同じ（パスワードの欄に value が付いていても捨てる）
		assert.deepStrictEqual(results.slice(0, 3).map(paradisParseMobileBrowserFocus), results.slice(0, 3));
		assert.strictEqual(paradisParseMobileBrowserFocus({ t: 'focus', targetId: 't1', seq: 1, focused: true, field: 'text', inputType: 'password', value: 'leak' })?.value, undefined);
	});

	test('欄の番号を付けて送り、置き換えは番号の欄にだけ効く式にする（改行はそのまま往復する）', () => {
		const context = { targetId: 't1', seq: 2, now: 10_000, lastTapAt: 0 };
		const area = paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: true, fieldId: 4, field: 'textarea', value: '一行目\n二行目', reason: 'focus' }), context);
		const broken = [0, -1, 1.5, 'x'].map(fieldId => paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: true, fieldId, field: 'text', value: '', reason: 'focus' }), context)?.fieldId);
		assert.deepStrictEqual({
			area,
			parsed: paradisParseMobileBrowserFocus(area),
			broken,
			select: [paradisMobileFocusSelectExpression(4), paradisMobileFocusSelectExpression(-3)],
		}, {
			area: { t: 'focus', targetId: 't1', seq: 2, focused: true, fieldId: 4, field: 'textarea', value: '一行目\n二行目' },
			parsed: { t: 'focus', targetId: 't1', seq: 2, focused: true, fieldId: 4, field: 'textarea', value: '一行目\n二行目' },
			broken: [undefined, undefined, undefined, undefined],
			select: [
				`typeof globalThis.__paraMobileFocusSelect === 'function' && globalThis.__paraMobileFocusSelect(4) === true`,
				`typeof globalThis.__paraMobileFocusSelect === 'function' && globalThis.__paraMobileFocusSelect(0) === true`,
			],
		});
	});

	test('注入スクリプトは欄に番号を振り、番号の違う欄・contenteditable を選ばず、最後のミラーが止めたときだけリスナーを外す', () => {
		// DOM の代わりに最小の偽物を置いて、スクリプトをそのまま評価する。番号の起点の乱数は固定する。
		const listeners = new Map<string, Function>();
		const selected: string[] = [];
		const reports: { fieldId?: number; field?: string; value?: string }[] = [];
		const field = (tagName: string, extra: object = {}) => ({ tagName, readOnly: false, disabled: false, value: 'v', isContentEditable: false, getAttribute: () => null, focus: () => { }, select: () => { selected.push(tagName); }, ...extra });
		const inputA = field('INPUT');
		const inputB = field('INPUT');
		const rich = field('DIV', { isContentEditable: true });
		const fakeDocument = {
			activeElement: inputA as unknown,
			addEventListener: (type: string, listener: Function) => listeners.set(type, listener),
			removeEventListener: (type: string) => listeners.delete(type),
		};
		const fakeGlobal: Record<string, unknown> = { [PARADIS_MOBILE_FOCUS_BINDING]: (payload: string) => reports.push(JSON.parse(payload)) };
		const install = (random: number) => new Function('globalThis', 'document', 'setTimeout', 'clearTimeout', 'Math', PARADIS_MOBILE_FOCUS_SCRIPT)(
			fakeGlobal, fakeDocument, (fn: () => void) => fn(), () => { }, { floor: Math.floor, max: Math.max, random: () => random });
		install(0);
		const report = fakeGlobal.__paraMobileFocusReport as (reason: string) => void;
		const select = fakeGlobal.__paraMobileFocusSelect as (fieldId: number) => boolean;
		report('tap');
		fakeDocument.activeElement = inputB;
		report('focus');
		const selectStaleA = select(1);
		const selectB = select(2);
		fakeDocument.activeElement = rich;
		report('focus');
		const selectRich = select(3);
		// 2 台目のミラーが同じワールドに入れる（入れ直さず数えるだけ）。1 台目が止めても外れない
		install(0.5);
		(fakeGlobal.__paraMobileFocusDispose as () => void)();
		fakeDocument.activeElement = inputB;
		const afterFirstStop = { listeners: listeners.size, selectB: (fakeGlobal.__paraMobileFocusSelect as (fieldId: number) => boolean)(2) };
		(fakeGlobal.__paraMobileFocusDispose as () => void)();
		assert.deepStrictEqual({
			reports: reports.map(r => ({ fieldId: r.fieldId, field: r.field, value: r.value })),
			selectStaleA, selectB, selectRich, selected, afterFirstStop, after: listeners.size, disposed: fakeGlobal.__paraMobileFocusSelect,
		}, {
			reports: [{ fieldId: 1, field: 'text', value: 'v' }, { fieldId: 2, field: 'text', value: 'v' }, { fieldId: 3, field: 'contenteditable', value: undefined }],
			selectStaleA: false, selectB: true, selectRich: false, selected: ['INPUT', 'INPUT'],
			afterFirstStop: { listeners: 3, selectB: true },
			after: 0, disposed: undefined,
		});
	});

	test('文書ごとに入れ直すスクリプトは、番号の起点を乱数にする（前の文書の番号と新しい文書の番号が重ならない）', () => {
		const firstIdWith = (random: number) => {
			const reports: { fieldId?: number }[] = [];
			const element = { tagName: 'INPUT', readOnly: false, disabled: false, value: '', isContentEditable: false, getAttribute: () => null };
			const fakeGlobal: Record<string, unknown> = { [PARADIS_MOBILE_FOCUS_BINDING]: (payload: string) => reports.push(JSON.parse(payload)) };
			new Function('globalThis', 'document', 'setTimeout', 'clearTimeout', 'Math', PARADIS_MOBILE_FOCUS_SCRIPT)(
				fakeGlobal, { activeElement: element, addEventListener: () => { }, removeEventListener: () => { } }, () => { }, () => { }, { floor: Math.floor, max: Math.max, random: () => random });
			(fakeGlobal.__paraMobileFocusReport as (reason: string) => void)('focus');
			return reports[0]?.fieldId;
		};
		const ids = [firstIdWith(0), firstIdWith(0.25), firstIdWith(0.999999)];
		assert.deepStrictEqual({
			ids,
			distinct: new Set(ids).size,
			allSafe: ids.every(id => typeof id === 'number' && Number.isSafeInteger(id) && id > 0),
			// アプリと PC の読み方を通っても番号は残る
			parsed: paradisNormalizeMobileBrowserFocusReport(JSON.stringify({ focused: true, fieldId: ids[2], field: 'text', value: '', reason: 'focus' }), { targetId: 't', seq: 1, now: 10_000, lastTapAt: 0 })?.fieldId,
		}, { ids: [1, 2 ** 38 + 1, Math.floor(0.999999 * 2 ** 40) + 1], distinct: 3, allSafe: true, parsed: Math.floor(0.999999 * 2 ** 40) + 1 });
	});
});
