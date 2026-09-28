/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { timeout } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAppendAgentListLockNotice } from '../../browser/paradisAgentListLockNotice.js';
import { IParadisAgentModelCatalogService, ParadisAgentListResetResult } from '../../common/paradisAgentModelCatalog.js';

suite('paradisAgentListLockNotice', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	async function clickReset(result: ParadisAgentListResetResult): Promise<{ events: string[]; noticeLeft: boolean }> {
		const events: string[] = [];
		const onDidChange = store.add(new Emitter<void>());
		const service: IParadisAgentModelCatalogService = {
			_serviceBrand: undefined,
			onDidChange: onDidChange.event,
			getAgentTemplates: () => [],
			refresh: () => { },
			isFixedBySettings: () => true,
			resetToDefault: async () => { events.push('confirm'); return result; },
			openSettingsJson: async () => { events.push(`open settings.json (dialog closed: ${closed})`); },
		};
		const container = mainWindow.document.createElement('div');
		let closed = false;
		let notice: IDisposable | undefined = undefined;
		// ダイアログを閉じると、ダイアログが持つ行も捨てられる
		notice = paradisAppendAgentListLockNotice(container, service, () => { closed = true; events.push('close dialog'); notice?.dispose(); });
		container.querySelector<HTMLButtonElement>('.paradis-agent-list-lock-reset')!.click();
		await timeout(0);
		notice.dispose();
		return { events, noticeLeft: container.querySelector('.paradis-agent-list-lock') !== null };
	}

	test('「settings.json を開く」を選んだら、ダイアログを閉じてから開く。戻したときや取りやめたときは閉じない', async () => {
		assert.deepStrictEqual({
			openSettings: await clickReset('openSettings'),
			reset: await clickReset('reset'),
			unchanged: await clickReset('unchanged'),
		}, {
			openSettings: { events: ['confirm', 'close dialog', 'open settings.json (dialog closed: true)'], noticeLeft: false },
			reset: { events: ['confirm'], noticeLeft: false },
			unchanged: { events: ['confirm'], noticeLeft: false },
		});
	});
});
