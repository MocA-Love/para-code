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
		// 実物に見えないよう、トークンは部品をつないで作る
		const join = (...parts: string[]) => parts.join('');
		const fakeGithub = join('ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123');
		const fakeOpenAi = join('sk', '-proj-', 'abcdefghijklmnopqrstu');
		const fakeStripe = join('sk', '_live_', 'abcdefghijklmnop');
		const fakeNpm = join('npm', '_', 'abcdefghijklmnopqrstuvwx1234');
		const fakeGitlab = join('glpat', '-', 'abcdefghijklmnopqrst');
		const fakeHf = join('hf', '_', 'abcdefghijklmnopqrstuvwxyz');
		const dsnKey = '0123456789abcdef0123456789abcdef';
		const cases = [
			`curl -H "Authorization: Bearer ${fakeGithub}" https://api.github.com`,
			`export OPENAI_API_KEY=${fakeOpenAi} && run`,
			`export STRIPE_SECRET_KEY=${fakeStripe} && npm run deploy`,
			'OPENAI_KEY=abc123def456 node x',
			'mysql --password=hunter2 -u root',
			'mysql -u root -phunter2 db',
			'docker login -p hunter2 registry.io',
			'curl -u admin:hunter2 https://example.com',
			'aws configure set aws_secret_access_key AbCdEf1234567890',
			`echo ${fakeNpm} ${fakeGitlab} ${fakeHf}`,
			`SENTRY_DSN=https://${dsnKey}@o1.ingest.sentry.io/1`,
			`curl https://${dsnKey}@o1.ingest.sentry.io/1`,
			'curl -X POST https://hooks.slack.com/services/T000/B000/XXXXXXXX',
			'-----BEGIN RSA PRIVATE KEY----- MIIEowIBAAKCAQEA',
			'git clone https://user:pa55word@example.com/repo.git',
			`git push ${join('ghp', '_abcdef')}\u2026`,
		];
		assert.deepStrictEqual(cases.map(paradisRedactSecrets), [
			'curl -H "Authorization: *** ***" https://api.github.com',
			'export OPENAI_API_KEY=*** && run',
			'export STRIPE_SECRET_KEY=*** && npm run deploy',
			'OPENAI_KEY=*** node x',
			'mysql --password=*** -u root',
			'mysql -u root -p*** db',
			'docker login -p *** registry.io',
			'curl -u admin:*** https://example.com',
			'aws configure set aws_secret_access_key ***',
			'echo *** *** ***',
			'SENTRY_DSN=***',
			'curl https://***@o1.ingest.sentry.io/1',
			'curl -X POST https://hooks.slack.com/services/***',
			'-----BEGIN RSA PRIVATE KEY----- ***',
			'git clone https://***@example.com/repo.git',
			'git push ***\u2026',
		]);
	});

	test('masks values written after a full-width colon or a Japanese item name', () => {
		const cases = [
			'password\uFF1Ahunter2 で入れます',
			'パスワード\uFF1Ahunter2 を設定しました',
			'トークン = abc123def を使います',
			'APIキー: "abc def" です',
			'パスワード\uFF1A必須チェックを追加しました',
		];
		assert.deepStrictEqual(cases.map(paradisRedactSecrets), [
			'password\uFF1A*** で入れます',
			'パスワード\uFF1A*** を設定しました',
			'トークン = *** を使います',
			'APIキー: *** です',
			'パスワード\uFF1A必須チェックを追加しました',
		]);
	});

	test('does not mask ordinary text that only looks like a key assignment', () => {
		const cases = [
			'型エラーを 3 件直し、monkey patch も外しました',
			'password:必須チェックを追加しました。テストも通っています',
			'Authorization: ヘッダーを付けるようにしました',
			'the non-secret value is fine',
			'rg --sort-key path src',
			'ssh -p 22 host',
			'docker run -p 8080:80 image',
			'token の残り時間を表示しました',
		];
		assert.deepStrictEqual(cases.map(paradisRedactSecrets), cases);
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
