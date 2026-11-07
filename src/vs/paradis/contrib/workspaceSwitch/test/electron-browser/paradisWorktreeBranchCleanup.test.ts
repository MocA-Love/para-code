/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese assertions)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { paradisHostPathFor } from '../../../../common/paradisHostPath.js';
import { IParadisForceDeleteBranchesRequest } from '../../common/paradisWorktreeCreate.js';
import { paradisForgetKeptBranches, paradisOpenKeptBranchesDialog, paradisPrefersBranchDeletion, paradisReadKeptBranches, paradisRecordKeptBranch, paradisRememberBranchDeletionChoice } from '../../electron-browser/paradisWorktreeBranchCleanup.js';
import { IParadisWorktreeGitHost } from '../../electron-browser/paradisWorktreeGitChannelClient.js';

suite('worktree branch cleanup', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	const repo = URI.file('/repo');
	const other = URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/repo' });

	test('remembers the branch deletion choice and the kept branches per repository', () => {
		const storage = store.add(new InMemoryStorageService());
		const before = paradisPrefersBranchDeletion(storage, repo);
		paradisRememberBranchDeletionChoice(storage, repo, false);
		paradisRecordKeptBranch(storage, repo, { name: 'feature/a', sha: '1111111aaaa' });
		paradisRecordKeptBranch(storage, repo, { name: 'feature/b', sha: '2222222bbbb' });
		paradisRecordKeptBranch(storage, repo, { name: 'feature/a', sha: '3333333cccc' });
		paradisRecordKeptBranch(storage, other, { name: 'feature/remote', sha: '4444444dddd' });
		paradisForgetKeptBranches(storage, repo, ['feature/b']);
		assert.deepStrictEqual({
			before,
			after: paradisPrefersBranchDeletion(storage, repo),
			otherRepo: paradisPrefersBranchDeletion(storage, other),
			kept: paradisReadKeptBranches(storage, repo),
			keptElsewhere: paradisReadKeptBranches(storage, other).map(branch => branch.name),
		}, {
			before: true,
			after: false,
			otherRepo: true,
			kept: [{ name: 'feature/a', sha: '3333333cccc' }],
			keptElsewhere: ['feature/remote'],
		});
	});

	test('force deletes only the selected branches and forgets the deleted ones', async () => {
		const storage = store.add(new InMemoryStorageService());
		paradisRecordKeptBranch(storage, repo, { name: 'feature/login', sha: '3f2a91c0000' });
		paradisRecordKeptBranch(storage, repo, { name: 'fix/elicitation', sha: '8c04d7e0000' });
		const requests: IParadisForceDeleteBranchesRequest[] = [];
		const called = new DeferredPromise<void>();
		const channel: IChannel = {
			call: async <T>(command: string, arg?: unknown) => {
				requests.push((arg as IParadisForceDeleteBranchesRequest[])[0]);
				called.complete();
				return { deleted: ['feature/login'], failed: [] } as T;
			},
			listen: () => Event.None,
		};
		const host: IParadisWorktreeGitHost = { channel, path: uri => paradisHostPathFor(uri, 'local') };
		const container = mainWindow.document.createElement('div');
		mainWindow.document.body.appendChild(container);
		const notifications = new TestNotificationService();
		try {
			paradisOpenKeptBranchesDialog({ activeContainer: container } as unknown as ILayoutService, storage, notifications as INotificationService, { id: 'repo', name: 'sample', uri: repo }, host, paradisReadKeptBranches(storage, repo));
			const dialog = container.querySelector<HTMLElement>('.paradis-kept-branches-dialog')!;
			const rows = () => [...dialog.querySelectorAll('.pkb-row')].map(row => row.textContent);
			const button = () => dialog.querySelector<HTMLElement>('.pkb-footer .pkb-danger')!;
			const initial = { rows: rows(), count: dialog.querySelector('.pkb-count')?.textContent, button: button().textContent, disabled: button().classList.contains('disabled') };
			dialog.querySelectorAll<HTMLInputElement>('.pkb-row .pkb-check')[0].click();
			const picked = { count: dialog.querySelector('.pkb-count')?.textContent, button: button().textContent };
			button().click();
			await called.p;
			await new Promise(resolve => setTimeout(resolve, 0));
			assert.deepStrictEqual({ initial, picked, requests, kept: paradisReadKeptBranches(storage, repo).map(branch => branch.name), closed: container.querySelector('.paradis-kept-branches-dialog') === null }, {
				initial: {
					rows: ['feature/loginsample · 3f2a91cマージされていない可能性', 'fix/elicitationsample · 8c04d7eマージされていない可能性'],
					count: '0 / 2 件を選択',
					button: '0 件のブランチを強制的に削除',
					disabled: true,
				},
				picked: { count: '1 / 2 件を選択', button: '1 件のブランチを強制的に削除' },
				requests: [{ repoPath: '/repo', branches: ['feature/login'] }],
				kept: ['fix/elicitation'],
				closed: true,
			});
		} finally {
			container.remove();
		}
	});
});
