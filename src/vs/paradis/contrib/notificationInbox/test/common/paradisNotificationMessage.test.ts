/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test data)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisInboxPaneKey, paradisPermissionPreview, paradisPickNotificationMessage, paradisRedactSecrets } from '../../common/paradisNotificationInbox.js';

suite('Paradis notification message', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('masks secret-looking values before a message reaches a notification', () => {
		const fakeGithub = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123'].join('_');
		const fakeOpenAi = ['sk', 'proj', 'abcdefghijklmnopqrstu'].join('-');
		assert.deepStrictEqual([
			paradisRedactSecrets(`curl -H "Authorization: Bearer ${fakeGithub}" https://api.github.com`),
			paradisRedactSecrets(`export OPENAI_API_KEY=${fakeOpenAi} && run`),
			paradisRedactSecrets('mysql --password=hunter2 -u root'),
			paradisRedactSecrets('git clone https://user:pa55word@example.com/repo.git'),
			paradisRedactSecrets('型エラーを 3 件直し、monkey patch も外しました'),
		], [
			'curl -H "Authorization: *** ***" https://api.github.com',
			'export OPENAI_API_KEY=*** && run',
			'mysql --password=*** -u root',
			'git clone https://***@example.com/repo.git',
			'型エラーを 3 件直し、monkey patch も外しました',
		]);
	});

	test('keeps permission previews to the tool name and a masked summary', () => {
		assert.deepStrictEqual([
			paradisPermissionPreview('npm test -- auth'),
			paradisPermissionPreview('Write: /repo/.env'),
			paradisPermissionPreview('WebFetch'),
			paradisPermissionPreview('TOKEN=abcdef123456 ./deploy.sh'),
		], [
			'Bash: npm test -- auth',
			'Write: /repo/.env',
			'WebFetch',
			'Bash: TOKEN=*** ./deploy.sh',
		]);
	});

	test('only uses a completion message written after the turn started', () => {
		const since = 10_000;
		assert.deepStrictEqual({
			fresh: paradisPickNotificationMessage({ lastMessage: { text: 'done', at: 12_000 } }, 'review', since),
			previousTurn: paradisPickNotificationMessage({ lastMessage: { text: 'old', at: 9_000 } }, 'review', since),
			notReadYet: paradisPickNotificationMessage({}, 'review', since),
			noSession: paradisPickNotificationMessage(undefined, 'review', since),
			question: paradisPickNotificationMessage({ interaction: { text: 'セッション方式？', at: 1 }, lastMessage: { text: 'x', at: 1 } }, 'question', since),
			permission: paradisPickNotificationMessage({ interaction: { text: 'npm test', at: 1 } }, 'permission', since),
		}, {
			fresh: { text: 'done', fresh: true },
			previousTurn: { text: undefined, fresh: false },
			notReadYet: { fresh: false },
			noSession: { fresh: true },
			question: { text: 'セッション方式？', fresh: true },
			permission: { text: 'Bash: npm test', fresh: true },
		});
	});

	test('derives a stable opaque pane key instead of exposing the token', () => {
		const key = paradisInboxPaneKey('pane-token-1');
		assert.deepStrictEqual({ stable: key === paradisInboxPaneKey('pane-token-1'), distinct: key !== paradisInboxPaneKey('pane-token-2'), opaque: !key.includes('pane-token'), length: key.length }, {
			stable: true, distinct: true, opaque: true, length: 40,
		});
	});
});
