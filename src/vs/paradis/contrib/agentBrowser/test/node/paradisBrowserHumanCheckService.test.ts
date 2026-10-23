/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisHumanCheckTracker } from '../../common/paradisBrowserHumanCheck.js';
import { ParadisAgentBrowserService } from '../../node/paradisAgentBrowserService.js';

interface IHumanCheckService {
	_withHumanCheck(lease: object, name: string, args: unknown, result: unknown, signal: AbortSignal | undefined): Promise<unknown>;
	_forgetHumanChecks(token: string): void;
}

suite('Paradis human check in tool results', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('adds the notice to action tools, notifies the user, closes the notification when it passes or the pane goes away', async () => {
		const binding = { pageId: 'tab-1', exactView: { viewId: 'view-1' } };
		let detected: string | null = 'page';
		const detections: unknown[][] = [];
		const notes: unknown[] = [];
		const polls: string[] = [];
		const service = Object.assign(Object.create(ParadisAgentBrowserService.prototype) as object, {
			_humanChecks: new ParadisHumanCheckTracker(),
			_humanCheckPolls: new Map<string, () => void>(),
			_defaultTabId: () => 'tab-1',
			_scopeBinding: (_token: string, tabId: string) => tabId === 'tab-1' ? binding : undefined,
			_bindings: new Map([['pane', binding]]),
			isIngressLeaseCurrent: () => true,
			mainProcessService: { getChannel: () => ({ call: async (_method: string, args: unknown[]) => { detections.push(args); return detected; } }) },
			_sendHumanCheckNote: (_token: string, tabId: string, kind: string | null) => notes.push([tabId, kind]),
			_startHumanCheckPoll: (token: string) => polls.push(token),
		}) as unknown as IHumanCheckService;
		const lease = { token: 'pane' };
		const ok = () => ({ content: [{ type: 'text', text: 'done' }] });
		const extra = (result: unknown) => (result as { content: { text: string }[] }).content.slice(1).map(item => item.text.split(':')[0]);

		const navigated = await service._withHumanCheck(lease, 'navigate_page', {}, ok(), undefined);
		const waited = await service._withHumanCheck(lease, 'wait_until', {}, ok(), undefined);
		const read = await service._withHumanCheck(lease, 'get_text', {}, ok(), undefined);
		detected = null;
		const passed = await service._withHumanCheck(lease, 'wait_until', {}, ok(), undefined);
		detected = 'page';
		await service._withHumanCheck(lease, 'navigate_page', { tab_id: 'tab-1' }, ok(), undefined);
		service._forgetHumanChecks('pane');

		assert.deepStrictEqual({
			navigated: extra(navigated),
			waited: extra(waited),
			read: extra(read),
			passed: extra(passed),
			alreadyReportedFlags: detections.map(args => args[1]),
			notes,
			polls,
		}, {
			navigated: ['PARA_BROWSER_HUMAN_CHECK'],
			waited: [],
			read: [],
			passed: ['PARA_BROWSER_HUMAN_CHECK_PASSED'],
			// 読むだけの道具（get_text）では見ない。知らせた後は待たずに見る
			alreadyReportedFlags: [false, true, true, false],
			notes: [['tab-1', 'page'], ['tab-1', null], ['tab-1', 'page'], ['tab-1', null]],
			polls: ['pane', 'pane'],
		});
	});
});
