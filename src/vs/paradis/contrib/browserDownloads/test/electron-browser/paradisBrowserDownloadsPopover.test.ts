/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import type { IManagedHoverContentOrFactory } from '../../../../../base/browser/ui/hover/hover.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ByteSize } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { NullHoverService } from '../../../../../platform/hover/test/browser/nullHoverService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IParadisBrowserDownloadItem, ParadisBrowserDownloadState, paradisFormatDownloadClock, paradisFormatDownloadDay, paradisFormatDownloadStart } from '../../common/paradisBrowserDownloads.js';
import { ParadisBrowserDownloadsPopover } from '../../electron-browser/paradisBrowserDownloadsPopover.js';
import { IParadisBrowserDownloadsService } from '../../electron-browser/paradisBrowserDownloadsService.js';

suite('ParadisBrowserDownloadsPopover', () => {

	const ds = ensureNoDisposablesAreLeakedInTestSuite();

	test('groups the list by the day a download started and starts each status with its time', () => {
		const now = new Date();
		const at = (dayOffset: number, hours: number, minutes: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hours, minutes, 5).getTime();
		const item = (id: string, state: ParadisBrowserDownloadState, startTime: number, extra: Partial<IParadisBrowserDownloadItem> = {}): IParadisBrowserDownloadItem => ({
			id, filename: `${id}.pdf`, savePath: `/dl/${id}.pdf`, url: `https://example.com/${id}.pdf`, state, receivedBytes: 241800, totalBytes: 241800, openable: true, fromAgent: false, startTime, ...extra,
		});
		// The service lists the newest first.
		const items = [
			item('running', 'progressing', at(0, 14, 32), { receivedBytes: 1000, totalBytes: 4000 }),
			item('done', 'completed', at(0, 9, 5)),
			item('agent', 'completed', at(-1, 23, 59), { fromAgent: true, savePath: '' }),
			item('failed', 'interrupted', at(-3, 8, 0)),
			item('old', 'cancelled', new Date(now.getFullYear() - 1, 2, 7, 10, 0).getTime()),
		];

		const onDidChange = ds.add(new Emitter<void>());
		const downloads: Partial<IParadisBrowserDownloadsService> = {
			onDidChange: onDidChange.event,
			items,
			markSeen: () => { },
		};
		const tooltips = new Map<HTMLElement, IManagedHoverContentOrFactory>();
		const hoverService: IHoverService = {
			...NullHoverService,
			setupManagedHover: (_delegate, target, content) => {
				tooltips.set(target, content);
				return NullHoverService.setupManagedHover(_delegate, target, content);
			},
		};
		const container = mainWindow.document.body.appendChild(mainWindow.document.createElement('div'));
		const instantiationService = ds.add(new TestInstantiationService());
		instantiationService.stub(IParadisBrowserDownloadsService, downloads);
		instantiationService.stub(IHoverService, hoverService);
		instantiationService.stub(ILayoutService, { activeContainer: container, getContainer: () => container });

		const popover = instantiationService.createInstance(ParadisBrowserDownloadsPopover, undefined, () => { });
		try {
			const list = container.querySelector('.pbd-list')!;
			const shown = [...list.children].map(child => child.classList.contains('pbd-group')
				? { group: child.textContent, role: child.getAttribute('role') }
				: {
					role: child.getAttribute('role'),
					name: child.querySelector('.pbd-name')!.textContent,
					status: child.querySelector('.pbd-status')!.textContent,
					tooltip: tooltips.get(child.querySelector<HTMLElement>('.pbd-name')!),
				});

			const opened = now.getTime();
			const started = (time: number) => `開始 ${paradisFormatDownloadStart(time)}`;
			const size = ByteSize.formatSize(241800);
			assert.deepStrictEqual({ listRole: list.getAttribute('role'), shown }, {
				listRole: 'list',
				shown: [
					{ group: paradisFormatDownloadDay(at(0, 14, 32), opened), role: 'presentation' },
					{ role: 'listitem', name: 'running.pdf', status: `${paradisFormatDownloadClock(at(0, 14, 32))} · ${ByteSize.formatSize(1000)} / ${ByteSize.formatSize(4000)}`, tooltip: `${started(at(0, 14, 32))}\n/dl/running.pdf` },
					{ role: 'listitem', name: 'done.pdf', status: `09:05 · 完了 · ${size}`, tooltip: `${started(at(0, 9, 5))}\n/dl/done.pdf` },
					{ group: '昨日', role: 'presentation' },
					{ role: 'listitem', name: 'agent.pdf', status: `23:59 · 完了 · ${size}`, tooltip: `${started(at(-1, 23, 59))}\nエージェントのタブから（「開く」は出ません）\nhttps://example.com/agent.pdf` },
					{ group: paradisFormatDownloadDay(at(-3, 8, 0), opened), role: 'presentation' },
					{ role: 'listitem', name: 'failed.pdf', status: '08:00 · 失敗しました', tooltip: `${started(at(-3, 8, 0))}\n/dl/failed.pdf` },
					{ group: `${now.getFullYear() - 1}年3月7日`, role: 'presentation' },
					{ role: 'listitem', name: 'old.pdf', status: '10:00 · 取り消しました', tooltip: `${started(new Date(now.getFullYear() - 1, 2, 7, 10, 0).getTime())}\n/dl/old.pdf` },
				],
			});
		} finally {
			popover.dispose();
			container.remove();
		}
	});
});
