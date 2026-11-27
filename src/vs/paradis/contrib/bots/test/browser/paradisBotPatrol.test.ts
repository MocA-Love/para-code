/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test names)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IParadisBotPatrolPort, ParadisBotPatrolSection } from '../../browser/paradisBotPatrol.js';
import { IParadisBotPatrolView } from '../../../scheduledRuns/common/paradisScheduledRunBotPatrol.js';

const VIEW = (activeRunId?: string): IParadisBotPatrolView => ({ definitionId: 'd', enabled: true, schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true }, cron: '0 8-20/4 * * 1-5', lookFor: '', gate: 'ok', ...(activeRunId !== undefined ? { activeRunId } : {}) });

suite('Paradis bot patrol section', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function section(get: () => Promise<IParadisBotPatrolView>) {
		const reads: string[] = [];
		const port: IParadisBotPatrolPort = {
			onDidChange: Event.None,
			get: async () => { reads.push('get'); return get(); },
			set: async () => ({ ok: true }),
			runNow: async () => ({ ok: true }),
		};
		const renders: number[] = [];
		const patrol = new ParadisBotPatrolSection('b1', port, { notificationService: new TestNotificationService(), contextViewService: {} as IContextViewService, configurationService: {} as IConfigurationService }, () => renders.push(1), () => { });
		const line = () => {
			const body = document.createElement('div');
			const disposables = store.add(new DisposableStore());
			patrol.renderHome(body, disposables);
			return body.getElementsByClassName('paradis-bot-patrol-line')[0].textContent;
		};
		return { patrol, reads, renders, line };
	}

	const settle = () => new Promise(resolve => setTimeout(resolve, 0));

	test('読み込み中に来た知らせは捨てず、読み終えた後にもう一度読んで新しい状態を出す', async () => {
		let release: (view: IParadisBotPatrolView) => void = () => { };
		let calls = 0;
		const { patrol, reads, line } = section(() => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : Promise.resolve(VIEW()));
		patrol.invalidate();
		// 回が終わった知らせが、走っている間の読み込みの最中に来る
		patrol.invalidate();
		release(VIEW('run-1'));
		await settle();
		await settle();
		assert.deepStrictEqual({ reads: reads.length, running: line()?.startsWith('見回り中') }, { reads: 2, running: false });
	});

	test('表示していない Bot の分は捨て、次に描くときに読み直す（戻ったときに古い「見回り中」を出さない）', async () => {
		let view = VIEW('run-1');
		const { patrol, reads, line } = section(() => Promise.resolve(view));
		line();
		await settle();
		const before = line();
		view = VIEW();
		patrol.forget();
		line();
		await settle();
		assert.deepStrictEqual({ reads: reads.length, before: before?.startsWith('見回り中'), after: line()?.startsWith('見回り中') }, { reads: 2, before: true, after: false });
	});
});
