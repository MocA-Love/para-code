/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_HUMAN_CHECK_WAIT_PREDICATE, ParadisHumanCheckTracker, paradisClassifyHumanCheckProbe, paradisHumanCheckNotice, paradisParseHumanCheckObservation } from '../../common/paradisBrowserHumanCheck.js';

suite('ParadisBrowserHumanCheck', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies the page probe and the observation sent from main', () => {
		assert.deepStrictEqual({
			probe: [
				paradisClassifyHumanCheckProbe({ page: true, unsolvedVisible: true, submits: 2 }),
				paradisClassifyHumanCheckProbe({ page: false, unsolvedVisible: true }),
				paradisClassifyHumanCheckProbe({ page: false, unsolvedVisible: false }),
				// 時間切れ（raceTimeout の undefined）は「無い」ではなく unknown
				paradisClassifyHumanCheckProbe(undefined),
			],
			parsed: [
				paradisParseHumanCheckObservation({ state: 'check', kind: 'widget', submits: 1 }),
				paradisParseHumanCheckObservation({ state: 'none' }),
				paradisParseHumanCheckObservation(null),
				paradisParseHumanCheckObservation('page'),
			],
		}, {
			probe: [
				{ state: 'check', kind: 'page', submits: 2 },
				{ state: 'check', kind: 'widget', submits: 0 },
				{ state: 'none' },
				{ state: 'unknown' },
			],
			parsed: [
				{ state: 'check', kind: 'widget', submits: 1 },
				{ state: 'none' },
				{ state: 'unknown' },
				{ state: 'unknown' },
			],
		});
	});

	test('stops the agent at a check page, but lets it fill a form with Turnstile until it tries to send', () => {
		const tracker = new ParadisHumanCheckTracker();
		const page = 'pane\npage-tab';
		const form = 'pane\nform-tab';
		const none = { state: 'none' } as const;
		const unknown = { state: 'unknown' } as const;
		const check = (kind: 'page' | 'widget', submits = 0) => ({ state: 'check', kind, submits }) as const;
		assert.deepStrictEqual({
			page: [
				tracker.observe(page, none),
				tracker.observe(page, check('page')),
				tracker.observe(page, check('page')),
				// 見られなかったときは何も変えない（通ったことにしない）
				tracker.observe(page, unknown),
				tracker.isNotified(page),
				tracker.observe(page, none),
				tracker.observe(page, none),
			],
			form: [
				tracker.observe(form, check('widget')),
				// 入力欄のクリック・Tab・fill（送信に当たる操作が増えない）では止めない
				tracker.observe(form, check('widget')),
				tracker.observe(form, check('widget')),
				// 送信に当たる操作が増えたのに残っている
				tracker.observe(form, check('widget', 1)),
				tracker.observe(form, check('widget', 2)),
				tracker.isNotified(form),
				// 見回りで通ったのを見つけた: 通知を閉じ、次の道具の結果に「通った」を足す
				tracker.markPassed(form),
				tracker.observe(form, none),
			],
		}, {
			page: [{}, { notice: 'page', notify: 'page' }, {}, {}, true, { notice: 'passed', close: true }, {}],
			form: [{ notice: 'widget' }, {}, {}, { notice: 'widgetBlocked', notify: 'widget' }, {}, true, true, { notice: 'passed', close: false }],
		});
	});

	test('forgets a pane and returns the tabs whose notification must be closed', () => {
		const tracker = new ParadisHumanCheckTracker();
		tracker.observe('pane\na', { state: 'check', kind: 'page', submits: 0 });
		tracker.observe('pane\nb', { state: 'check', kind: 'widget', submits: 0 });
		tracker.observe('other\nc', { state: 'check', kind: 'page', submits: 0 });
		assert.deepStrictEqual({ closed: tracker.forget('pane'), kept: tracker.has('other\nc'), forgotten: tracker.has('pane\na') }, { closed: ['a'], kept: true, forgotten: false });
	});

	test('tells the agent to wait for a person with a wait_until predicate', () => {
		const notice = paradisHumanCheckNotice('page', 'tab-1');
		const widget = paradisHumanCheckNotice('widget', 'tab-1');
		assert.deepStrictEqual({
			marker: notice.startsWith('PARA_BROWSER_HUMAN_CHECK:'),
			predicate: notice.includes(JSON.stringify(PARADIS_HUMAN_CHECK_WAIT_PREDICATE)),
			tab: notice.includes('tab_id "tab-1"'),
			noBypass: notice.includes('do not click it, solve it or try to get around it'),
			widgetLetsFormContinue: widget.includes('you can keep filling in the form'),
			passed: paradisHumanCheckNotice('passed', 'tab-1').startsWith('PARA_BROWSER_HUMAN_CHECK_PASSED:'),
			mainWaits100: notice.includes('timeout_seconds 100,'),
			subagentWaits250: paradisHumanCheckNotice('page', 'tab-1', true).includes('timeout_seconds 250,'),
		}, { marker: true, predicate: true, tab: true, noBypass: true, widgetLetsFormContinue: true, passed: true, mainWaits100: true, subagentWaits250: true });
	});
});
