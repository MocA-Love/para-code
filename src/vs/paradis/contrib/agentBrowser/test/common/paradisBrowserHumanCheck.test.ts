/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_HUMAN_CHECK_WAIT_PREDICATE, ParadisHumanCheckTracker, paradisClassifyHumanCheckProbe, paradisHumanCheckNotice } from '../../common/paradisBrowserHumanCheck.js';

suite('ParadisBrowserHumanCheck', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies the page probe', () => {
		assert.deepStrictEqual([
			paradisClassifyHumanCheckProbe({ page: true, unsolvedVisible: true }),
			paradisClassifyHumanCheckProbe({ page: false, unsolvedVisible: true }),
			paradisClassifyHumanCheckProbe({ page: false, unsolvedVisible: false }),
			paradisClassifyHumanCheckProbe(undefined),
		], ['page', 'widget', undefined, undefined]);
	});

	test('stops the agent at a check page, but lets it fill a form with Turnstile until it tries to send', () => {
		const tracker = new ParadisHumanCheckTracker();
		const page = 'pane\npage-tab';
		const form = 'pane\nform-tab';
		assert.deepStrictEqual({
			page: [
				tracker.observe(page, undefined, 'navigate_page'),
				tracker.observe(page, 'page', 'navigate_page'),
				tracker.observe(page, 'page', 'wait_until'),
				tracker.observe(page, undefined, 'wait_until'),
				tracker.observe(page, undefined, 'take_snapshot'),
			],
			form: [
				tracker.observe(form, 'widget', 'navigate_page'),
				tracker.observe(form, 'widget', 'fill_by'),
				tracker.observe(form, 'widget', 'click_by'),
				tracker.observe(form, 'widget', 'click_by'),
				tracker.isNotified(form),
				// 見回りで通ったのを見つけた: 通知を閉じ、次の道具の結果に「通った」を足す
				tracker.markPassed(form),
				tracker.observe(form, undefined, 'wait_until'),
			],
		}, {
			page: [{}, { notice: 'page', notify: 'page' }, {}, { notice: 'passed', close: true }, {}],
			form: [{ notice: 'widget' }, {}, { notice: 'widgetBlocked', notify: 'widget' }, {}, true, true, { notice: 'passed', close: false }],
		});
	});

	test('forgets a pane and returns the tabs whose notification must be closed', () => {
		const tracker = new ParadisHumanCheckTracker();
		tracker.observe('pane\na', 'page', 'navigate_page');
		tracker.observe('pane\nb', 'widget', 'navigate_page');
		tracker.observe('other\nc', 'page', 'navigate_page');
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
		}, { marker: true, predicate: true, tab: true, noBypass: true, widgetLetsFormContinue: true, passed: true });
	});
});
