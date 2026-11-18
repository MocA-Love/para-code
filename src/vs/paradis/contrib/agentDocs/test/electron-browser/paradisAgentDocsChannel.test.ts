/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IParadisAgentApprovalRequest, ParadisAgentApprovalOutcome } from '../../../agentBrowser/electron-browser/paradisAgentBrowserTabsService.js';
import { IParadisAgentDocsWindow, ParadisAgentDocsChannel, paradisDocFolderOf } from '../../electron-browser/paradisAgentDocsChannel.js';

function fakeWindow(remoteAuthority: string | undefined, files: Map<string, { isFile: boolean; real?: string }>, folder?: URI): IParadisAgentDocsWindow & { stats: string[] } {
	const stats: string[] = [];
	return {
		stats,
		remoteAuthority,
		paneKnown: token => token === 'p1',
		paneFolder: () => folder,
		stat: async resource => {
			stats.push(resource.toString());
			const file = files.get(resource.path);
			return file !== undefined ? { isFile: file.isFile } : undefined;
		},
		realpath: async resource => {
			const real = files.get(resource.path)?.real;
			return real !== undefined ? resource.with({ path: real }) : resource;
		},
	};
}

suite('paradisAgentDocsChannel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('turns space folders into the ledger form', () => {
		assert.deepStrictEqual([
			paradisDocFolderOf(URI.file('/repo/')),
			paradisDocFolderOf(URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/srv/app' })),
			paradisDocFolderOf(URI.from({ scheme: 'untitled', path: 'x' })),
		], [{ hostId: '', path: '/repo' }, { hostId: 'ssh-remote-box', path: '/srv/app' }, undefined]);
	});

	test('inspects only the files of its own machine and reads them through the remote connection in an SSH window', async () => {
		const window = fakeWindow('ssh-remote+box', new Map([['/srv/app/a.md', { isFile: true, real: '/data/a.md' }], ['/srv/app/dir.md', { isFile: false }]]), URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+box', path: '/srv/app' }));
		const channel = new ParadisAgentDocsChannel(window, async () => 'approve');
		const result = await channel.inspect('p1', [{ path: '/srv/app/a.md' }, { hostId: 'ssh-remote-box', path: '/srv/app/dir.md' }, { hostId: '', path: '/srv/app/a.md' }, { path: '/srv/app/none.md' }, { path: 'relative.md' }]);
		const unknown = await channel.inspect('p9', [{ path: '/srv/app/a.md' }]);
		assert.deepStrictEqual({ result, unknown, stats: window.stats }, {
			result: {
				paneKnown: true,
				windowHostId: 'ssh-remote-box',
				folder: { hostId: 'ssh-remote-box', path: '/srv/app' },
				files: [{ exists: true, isFile: true, realPath: '/data/a.md' }, { exists: true, isFile: false, realPath: '/srv/app/dir.md' }, {}, { exists: false }, {}],
			},
			unknown: { paneKnown: false, windowHostId: 'ssh-remote-box', files: [{}] },
			stats: ['vscode-remote://ssh-remote%2Bbox/srv/app/a.md', 'vscode-remote://ssh-remote%2Bbox/srv/app/dir.md', 'vscode-remote://ssh-remote%2Bbox/srv/app/none.md'],
		});
	});

	test('asks once with cleaned file names and the reason, and never treats the second choice as approval', async () => {
		const asked: { token: string; message: string; detail: readonly string[]; approveLabel: string; cooldownKey?: string }[] = [];
		let answer: ParadisAgentApprovalOutcome | 'timedOut' = 'approve';
		const channel = new ParadisAgentDocsChannel(fakeWindow(undefined, new Map()), async (token, request: IParadisAgentApprovalRequest) => {
			asked.push({ token, message: request.messageTemplate('「ターミナル 2」'), detail: request.detail, approveLabel: request.approveLabel, cooldownKey: request.cooldownKey });
			return answer;
		});
		const names = Array.from({ length: 12 }, (_, index) => `doc${index}.md`);
		const outcomes = [
			await channel.confirmAdopt('p1', { names: ['a‮.md', 'b.html'], reason: '頼まれた\n引き継ぎ' }, CancellationToken.None),
			await channel.confirmAdopt('p9', { names: ['a.md'] }, CancellationToken.None),
			await channel.confirmAdopt('p1', { names: [] }, CancellationToken.None),
		];
		answer = 'alternative';
		outcomes.push(await channel.confirmAdopt('p1', { names }, CancellationToken.None));
		assert.deepStrictEqual({ outcomes, asked }, {
			outcomes: ['approve', 'paneUnknown', 'denied', 'denied'],
			asked: [
				{
					token: 'p1',
					message: '「ターミナル 2」 のエージェントが、別のエージェントが作った資料を自分の資料に移そうとしています',
					detail: ['a .md', 'b.html', 'エージェントが示した理由: 頼まれた 引き継ぎ', '移すと、資料の持ち主がこのターミナルのエージェントになります。ファイルの中身は変わりません。'],
					approveLabel: '移す',
					cooldownKey: 'agent-docs-adopt',
				},
				{
					token: 'p1',
					message: '「ターミナル 2」 のエージェントが、別のエージェントが作った資料を自分の資料に移そうとしています',
					detail: [...names.slice(0, 10), 'ほか 2 件', '移すと、資料の持ち主がこのターミナルのエージェントになります。ファイルの中身は変わりません。'],
					approveLabel: '移す',
					cooldownKey: 'agent-docs-adopt',
				},
			],
		});
	});
});
