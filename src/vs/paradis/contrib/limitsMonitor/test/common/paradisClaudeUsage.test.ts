/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	paradisApplyRefreshedClaudeToken,
	paradisClaudeIdentitiesMatch,
	paradisClaudeIdentityFromOauthAccount,
	paradisIsClaudeTokenExpiring,
	paradisIsUsableClaudeCredentials,
	paradisParseClaudeUsage,
	paradisParseRetryAfterS
} from '../../common/paradisClaudeUsage.js';

suite('ParadisClaudeUsage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps the usage response, including model-scoped weekly limits', () => {
		assert.deepStrictEqual(paradisParseClaudeUsage({
			five_hour: { utilization: 42.5, resets_at: '2026-09-27T10:00:00.000Z' },
			seven_day: { utilization: 130, resets_at: 1_790_000_000 },
			limits: [
				{ kind: 'weekly_scoped', percent: 12, resets_at: '2026-10-01T00:00:00Z', scope: { model: { display_name: 'Fable' } } },
				{ kind: 'weekly', percent: 99 },
				{ kind: 'weekly_scoped', percent: 'x', scope: { model: { display_name: 'Broken' } } },
			],
		}), {
			fiveHour: { usedPercent: 42.5, resetsAt: Date.parse('2026-09-27T10:00:00.000Z'), label: undefined },
			// 100% を超える値は 100 に丸める。epoch 秒は ms にする
			sevenDay: { usedPercent: 100, resetsAt: 1_790_000_000_000, label: undefined },
			scoped: [{ usedPercent: 12, resetsAt: Date.parse('2026-10-01T00:00:00Z'), label: 'Fable' }],
		});
		assert.deepStrictEqual(paradisParseClaudeUsage('nonsense'), {});
		assert.deepStrictEqual(paradisParseClaudeUsage({ five_hour: null }), { fiveHour: undefined, sevenDay: undefined, scoped: undefined });
	});

	test('parses Retry-After as seconds or an HTTP date', () => {
		const now = Date.parse('2026-09-27T00:00:00Z');
		assert.deepStrictEqual([
			paradisParseRetryAfterS('120', now),
			paradisParseRetryAfterS('Sun, 27 Sep 2026 00:10:00 GMT', now),
			paradisParseRetryAfterS('garbage', now),
			paradisParseRetryAfterS(null, now),
		], [120, 600, undefined, undefined]);
	});

	test('recognises usable, expiring and wiped credentials', () => {
		const now = 1_000_000;
		const credentials = (oauth: object) => JSON.stringify({ claudeAiOauth: oauth });
		assert.deepStrictEqual({
			usable: paradisIsUsableClaudeCredentials(credentials({ accessToken: 'a', refreshToken: 'r', expiresAt: now + 3600_000 })),
			// Claude Code が更新を拒否されたときに空にした跡
			wiped: paradisIsUsableClaudeCredentials(credentials({ accessToken: '', refreshToken: '' })),
			notJson: paradisIsUsableClaudeCredentials('sk-ant-api-key'),
			fresh: paradisIsClaudeTokenExpiring(credentials({ accessToken: 'a', expiresAt: now + 3600_000 }), now),
			withinBuffer: paradisIsClaudeTokenExpiring(credentials({ accessToken: 'a', expiresAt: now + 60_000 }), now),
			unknownExpiry: paradisIsClaudeTokenExpiring(credentials({ accessToken: 'a' }), now),
		}, {
			usable: true,
			wiped: false,
			notJson: false,
			fresh: false,
			withinBuffer: true,
			unknownExpiry: true,
		});
	});

	test('applies a refreshed token without dropping other fields', () => {
		const before = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: 1, subscriptionType: 'max' }, mcpOAuth: { keep: true } });
		const rotated = JSON.parse(paradisApplyRefreshedClaudeToken(before, { access_token: 'new', refresh_token: 'r2', expires_in: 3600, scope: 'user:inference user:profile' }, 1000)!);
		const notRotated = JSON.parse(paradisApplyRefreshedClaudeToken(before, { access_token: 'new2' }, 1000)!);
		assert.deepStrictEqual({ rotated, notRotated: notRotated.claudeAiOauth, missingAccess: paradisApplyRefreshedClaudeToken(before, {}, 1000) }, {
			rotated: {
				claudeAiOauth: { accessToken: 'new', refreshToken: 'r2', expiresAt: 3_601_000, subscriptionType: 'max', scopes: ['user:inference', 'user:profile'] },
				mcpOAuth: { keep: true },
			},
			// サーバーがリフレッシュトークンを回さなかったときは今のものを残す
			notRotated: { accessToken: 'new2', refreshToken: 'r1', expiresAt: 1, subscriptionType: 'max' },
			missingAccess: undefined,
		});
	});

	test('matches identities by account uuid, then e-mail, and keeps organisations apart', () => {
		const alice = paradisClaudeIdentityFromOauthAccount({ accountUuid: 'u1', emailAddress: 'Alice@example.com', organizationUuid: 'o1', organizationName: 'Personal' });
		assert.deepStrictEqual({
			alice,
			sameUuid: paradisClaudeIdentitiesMatch(alice, { accountUuid: 'u1', email: 'renamed@example.com' }),
			otherUuid: paradisClaudeIdentitiesMatch(alice, { accountUuid: 'u2', email: 'alice@example.com' }),
			emailOnly: paradisClaudeIdentitiesMatch(alice, { email: 'alice@EXAMPLE.com' }),
			otherOrg: paradisClaudeIdentitiesMatch(alice, { accountUuid: 'u1', organizationUuid: 'o2' }),
			empty: paradisClaudeIdentityFromOauthAccount({}),
		}, {
			alice: { accountUuid: 'u1', email: 'Alice@example.com', organizationUuid: 'o1', organizationName: 'Personal' },
			sameUuid: true,
			otherUuid: false,
			emailOnly: true,
			otherOrg: false,
			empty: undefined,
		});
	});
});
