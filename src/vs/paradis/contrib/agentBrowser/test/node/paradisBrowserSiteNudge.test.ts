/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';
import { PARADIS_SITE_NUDGE_MAX_PER_AGENT, ParadisSiteNudges, paradisSiteNudgeText } from '../../node/paradisBrowserSiteNudge.js';

suite('Paradis site note nudges (Q327)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a success after an error or a repeated action on the same tab is a recovery; ordinary work is not', () => {
		const nudges = new ParadisSiteNudges();
		const seen = (tab: string, tool: string, args: object, failed = false) => nudges.observe('pane', tab, tool, args, failed);
		assert.deepStrictEqual({
			// フォームを順に埋めて送るだけ
			plain: [
				seen('t1', 'fill_by', { name: 'Email', value: 'a' }),
				seen('t1', 'fill_by', { name: 'Name', value: 'b' }),
				seen('t1', 'press_key', { key: 'Tab' }),
				seen('t1', 'press_key', { key: 'Tab' }),
				seen('t1', 'click_by', { role: 'button', name: 'Send' }),
				seen('t1', 'take_snapshot', {}),
			],
			// エラーの後に別のやり方で成功
			afterError: [
				seen('t1', 'click_by', { text: 'Pay' }, true),
				seen('t1', 'take_snapshot', {}),
				seen('t1', 'click', { uid: '1_5' }),
				seen('t1', 'click_by', { text: 'Next' }),
			],
			// 同じ操作を続けてやり直した後に、別の操作で成功
			afterRepeat: [
				seen('t2', 'click_by', { text: 'Save', includeSnapshot: true }),
				seen('t2', 'click_by', { text: 'Save' }),
				seen('t2', 'click_by', { text: 'Unlock cart' }),
			],
			// 別のタブの失敗は数えない
			otherTab: [
				seen('t3', 'fill_by', { name: 'Card' }, true),
				seen('t4', 'click_by', { text: 'OK' }),
			],
		}, {
			plain: [false, false, false, false, false, false],
			afterError: [false, false, true, false],
			afterRepeat: [false, false, true],
			otherTab: [false, false],
		});
	});

	test('a pane gets at most a few nudges until a new agent connects, and the text names only the tools that are on', () => {
		const nudges = new ParadisSiteNudges();
		const recover = () => (nudges.observe('pane', 't', 'click_by', { text: 'A' }, true), nudges.observe('pane', 't', 'click_by', { text: 'B' }, false));
		const first = Array.from({ length: PARADIS_SITE_NUDGE_MAX_PER_AGENT + 2 }, recover);
		nudges.forget('pane');
		assert.deepStrictEqual({
			first,
			afterNewAgent: recover(),
			notes: paradisSiteNudgeText({ notes: true, recipes: false }),
			both: paradisSiteNudgeText({ notes: true, recipes: true }),
			none: paradisSiteNudgeText({ notes: false, recipes: false }),
		}, {
			first: [true, true, true, false, false],
			afterNewAgent: true,
			notes: '[Para Code] You got past a failed or repeated step on this site. Before you go on, record what made it work in a short note with write_site_note (one short call, for example the input format or the element that worked), so the next agent does not repeat the trouble. Do not include secrets or values that only apply to this run.',
			both: '[Para Code] You got past a failed or repeated step on this site. Before you go on, record what made it work in a short note with write_site_note, or the steps with save_recipe (one short call, for example the input format or the element that worked), so the next agent does not repeat the trouble. Do not include secrets or values that only apply to this run.',
			none: undefined,
		});
	});

	test('the service adds the line to the tool result after a recovery on the default tab', () => {
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_siteNudges: new ParadisSiteNudges(),
			_defaultTabId: () => 'tab-1',
		}) as unknown as { _withSiteNudge(lease: object, name: string, args: unknown, result: unknown, kinds: { notes: boolean; recipes: boolean }): unknown };
		const kinds = { notes: true, recipes: false };
		const failed = { content: [{ type: 'text', text: 'no element' }], isError: true };
		const ok = { content: [{ type: 'text', text: 'clicked' }] };
		const lease = { token: 'pane' };
		const afterError = service._withSiteNudge(lease, 'click_by', { text: 'Pay' }, failed, kinds);
		const recovered = service._withSiteNudge(lease, 'click', { uid: '1_5' }, ok, kinds) as { content: { text: string }[] };
		assert.deepStrictEqual({
			afterError: afterError === failed,
			recovered: recovered.content.map(item => item.text.slice(0, 40)),
		}, {
			afterError: true,
			recovered: ['clicked', '[Para Code] You got past a failed or rep'],
		});
	});
});
