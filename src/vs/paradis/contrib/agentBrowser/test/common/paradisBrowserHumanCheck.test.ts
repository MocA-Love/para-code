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

	test('reports a check once per tab and the pass once', () => {
		const tracker = new ParadisHumanCheckTracker();
		assert.deepStrictEqual([
			tracker.observe('pane\ntab', undefined),
			tracker.observe('pane\ntab', 'page'),
			tracker.observe('pane\ntab', 'page'),
			tracker.observe('pane\ntab', 'widget'),
			tracker.has('pane\ntab'),
			tracker.observe('pane\ntab', undefined),
			tracker.observe('pane\ntab', undefined),
		], [
			undefined,
			{ type: 'appeared', kind: 'page' },
			undefined,
			{ type: 'appeared', kind: 'widget' },
			true,
			{ type: 'passed' },
			undefined,
		]);
	});

	test('tells the agent to wait for a person with a wait_until predicate', () => {
		const notice = paradisHumanCheckNotice('page', 'tab-1');
		assert.deepStrictEqual({
			marker: notice.startsWith('PARA_BROWSER_HUMAN_CHECK:'),
			predicate: notice.includes(JSON.stringify(PARADIS_HUMAN_CHECK_WAIT_PREDICATE)),
			tab: notice.includes('tab_id "tab-1"'),
			noBypass: notice.includes('do not click it, solve it or try to get around it'),
		}, { marker: true, predicate: true, tab: true, noBypass: true });
	});
});
