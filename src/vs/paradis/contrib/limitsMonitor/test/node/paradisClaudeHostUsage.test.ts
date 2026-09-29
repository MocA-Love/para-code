/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// SSH の接続先（REH）で接続先の Claude のログインの使用量を読む部分のテスト。HOME は一時ディレクトリ、
// HTTP は差し込んだ偽の fetch で、本物の ~/.claude・キーチェーン・Anthropic の API には触れない。

import assert from 'assert';
import * as fs from 'fs';
import * as path from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisClaudeAccountsState } from '../../common/paradisClaudeAccounts.js';
import { PARADIS_CLAUDE_USAGE_URL } from '../../common/paradisClaudeUsage.js';
import { ParadisClaudeHostUsage } from '../../node/paradisClaudeHostUsage.js';
import { ParadisClaudeOAuthClient } from '../../node/paradisClaudeOAuthClient.js';
import { paradisCreateClaudeTestHome, paradisTestCredentials, paradisTestOauthAccount, paradisWriteClaudeGlobalConfig } from './paradisClaudeTestUtils.js';

const HOUR = 3600_000;
const MINUTE = 60_000;

interface IFetchCall {
	readonly url: string;
	readonly method: string | undefined;
	readonly authorization: string | undefined;
}

interface IHarness {
	readonly home: string;
	readonly calls: IFetchCall[];
	readonly reader: ParadisClaudeHostUsage;
	/** 次の応答（無ければ 200 で使用率 42%）。 */
	responses: { status: number; body?: object; headers?: Record<string, string> }[];
	now: number;
}

const USAGE_BODY = {
	five_hour: { utilization: 42, resets_at: '2030-01-01T02:00:00Z' },
	seven_day: { utilization: 10, resets_at: '2030-01-05T00:00:00Z' },
	limits: [{ kind: 'weekly_scoped', percent: 7, resets_at: '2030-01-05T00:00:00Z', scope: { model: { display_name: 'Fable' } } }],
};

/** 表示に使う項目だけ（1つの deepStrictEqual で比べるため）。 */
function summarize(state: IParadisClaudeAccountsState): object {
	return state.claude.accounts.map(account => ({
		id: account.id,
		email: account.email,
		homeLabel: account.homeLabel,
		status: account.status,
		unavailableReason: account.unavailableReason,
		fiveHour: account.fiveHour?.usedPercent,
		sevenDay: account.sevenDay?.usedPercent,
		scoped: account.scoped?.map(window => `${window.label}:${window.usedPercent}`),
		active: account.active,
		managed: account.managed,
		registrable: account.registrable,
	}));
}

/** HOME の下のファイルの一覧と中身（書き込みが無いことを確かめるため）。 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				result[path.relative(root, full) + '/'] = '';
				await walk(full);
			} else {
				const stat = await fs.promises.stat(full);
				result[path.relative(root, full)] = `${stat.mtimeMs}:${await fs.promises.readFile(full, 'utf8')}`;
			}
		}
	}
	await walk(root);
	return result;
}

suite('ParadisClaudeHostUsage (REH, read-only)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let cleanup: (() => Promise<void>) | undefined;

	teardown(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	async function createHarness(options: { platform?: NodeJS.Platform; configDir?: (home: string) => string } = {}): Promise<IHarness> {
		const dirs = await paradisCreateClaudeTestHome();
		cleanup = dirs.dispose;
		const harness = { home: dirs.home, calls: [] as IFetchCall[], responses: [] as IHarness['responses'], now: Date.parse('2029-12-31T12:00:00Z') };
		const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const headers = (init?.headers ?? {}) as Record<string, string>;
			harness.calls.push({ url: String(input), method: init?.method, authorization: headers.Authorization });
			const next = harness.responses.shift() ?? { status: 200, body: USAGE_BODY };
			return new Response(next.body !== undefined ? JSON.stringify(next.body) : null, { status: next.status, headers: next.headers });
		};
		const reader = new ParadisClaudeHostUsage({
			homedir: dirs.home,
			platform: options.platform ?? 'linux',
			configDir: options.configDir?.(dirs.home),
			oauth: new ParadisClaudeOAuthClient(fakeFetch as typeof fetch, () => harness.now),
			logService: new NullLogService(),
			now: () => harness.now,
			random: () => 0.5,
		});
		return Object.assign(harness, { reader });
	}

	async function writeCredentials(dir: string, accessToken: string, expiresAt: number): Promise<void> {
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(path.join(dir, '.credentials.json'), paradisTestCredentials(accessToken, `${accessToken}-refresh`, expiresAt));
	}

	test('valid token: calls the usage API from this process with the host token and returns only usage and identity', async () => {
		const harness = await createHarness();
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-host', 'host@example.com') });
		await writeCredentials(path.join(harness.home, '.claude'), 'host-access', harness.now + HOUR);
		const before = await snapshotTree(harness.home);

		const state = await harness.reader.getState(undefined);

		assert.deepStrictEqual({
			accounts: summarize(state),
			calls: harness.calls,
			switching: state.switching,
			oldestFetchedAt: state.oldestFetchedAt,
			tokenLeaked: JSON.stringify(state).includes('host-access'),
			filesUnchanged: JSON.stringify(await snapshotTree(harness.home)) === JSON.stringify(before),
		}, {
			accounts: [{ id: 'claude-host', email: 'host@example.com', homeLabel: '~/.claude', status: 'ok', unavailableReason: undefined, fiveHour: 42, sevenDay: 10, scoped: ['Fable:7'], active: undefined, managed: undefined, registrable: undefined }],
			calls: [{ url: PARADIS_CLAUDE_USAGE_URL, method: 'GET', authorization: 'Bearer host-access' }],
			switching: false,
			oldestFetchedAt: harness.now,
			tokenLeaked: false,
			filesUnchanged: true,
		});
	});

	test('expired token: waits for Claude Code on the host to refresh, never refreshes or writes, then picks up the new token', async () => {
		const harness = await createHarness();
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-host', 'host@example.com') });
		await writeCredentials(path.join(harness.home, '.claude'), 'old-access', harness.now - MINUTE);
		const before = await snapshotTree(harness.home);

		const waiting = summarize(await harness.reader.getState({ refresh: true }));
		const filesUnchanged = JSON.stringify(await snapshotTree(harness.home)) === JSON.stringify(before);
		const callsWhileExpired = [...harness.calls];

		// 接続先の Claude Code がトークンを更新して書き戻した
		harness.now += MINUTE;
		await writeCredentials(path.join(harness.home, '.claude'), 'new-access', harness.now + 8 * HOUR);
		const refreshed = summarize(await harness.reader.getState(undefined));

		assert.deepStrictEqual({ waiting, filesUnchanged, callsWhileExpired, refreshed, calls: harness.calls.map(call => call.authorization) }, {
			waiting: [{ id: 'claude-host', email: 'host@example.com', homeLabel: '~/.claude', status: 'refreshing', unavailableReason: undefined, fiveHour: undefined, sevenDay: undefined, scoped: undefined, active: undefined, managed: undefined, registrable: undefined }],
			filesUnchanged: true,
			callsWhileExpired: [],
			refreshed: [{ id: 'claude-host', email: 'host@example.com', homeLabel: '~/.claude', status: 'ok', unavailableReason: undefined, fiveHour: 42, sevenDay: 10, scoped: ['Fable:7'], active: undefined, managed: undefined, registrable: undefined }],
			calls: ['Bearer new-access'],
		});
	});

	test('401 before the expiry is also left to Claude Code on the host (no refresh request)', async () => {
		const harness = await createHarness();
		await writeCredentials(path.join(harness.home, '.claude'), 'revoked-access', harness.now + HOUR);
		harness.responses.push({ status: 401 });
		const before = await snapshotTree(harness.home);

		const state = summarize(await harness.reader.getState(undefined));

		assert.deepStrictEqual({ state, urls: harness.calls.map(call => call.url), filesUnchanged: JSON.stringify(await snapshotTree(harness.home)) === JSON.stringify(before) }, {
			state: [{ id: 'claude-host', email: undefined, homeLabel: '~/.claude', status: 'refreshing', unavailableReason: undefined, fiveHour: undefined, sevenDay: undefined, scoped: undefined, active: undefined, managed: undefined, registrable: undefined }],
			urls: [PARADIS_CLAUDE_USAGE_URL],
			filesUnchanged: true,
		});
	});

	test('missing credentials: not logged in, no API call', async () => {
		const harness = await createHarness();

		const state = summarize(await harness.reader.getState({ refresh: true }));

		assert.deepStrictEqual({ state, calls: harness.calls }, {
			state: [{ id: 'claude-host', email: undefined, homeLabel: '~/.claude', status: 'no_credentials', unavailableReason: undefined, fiveHour: undefined, sevenDay: undefined, scoped: undefined, active: undefined, managed: undefined, registrable: undefined }],
			calls: [],
		});
	});

	test('macOS host with the login only in the keychain: cannot be read over SSH, no API call', async () => {
		const harness = await createHarness({ platform: 'darwin' });
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-mac', 'mac@example.com') });

		const state = summarize(await harness.reader.getState({ refresh: true }));

		assert.deepStrictEqual({ state, calls: harness.calls }, {
			state: [{ id: 'claude-host', email: 'mac@example.com', homeLabel: '~/.claude', status: 'unavailable', unavailableReason: 'keychain_unavailable', fiveHour: undefined, sevenDay: undefined, scoped: undefined, active: undefined, managed: undefined, registrable: undefined }],
			calls: [],
		});
	});

	test('keeps to the poll policy: no refetch within the interval, manual refresh honors the 180 s TTL, 429 backs off', async () => {
		const harness = await createHarness();
		await writeCredentials(path.join(harness.home, '.claude'), 'host-access', harness.now + 24 * HOUR);

		await harness.reader.getState(undefined);
		harness.now += MINUTE;
		await harness.reader.getState(undefined);
		await harness.reader.getState({ refresh: true });
		const afterFirst = harness.calls.length;

		// 180 秒を過ぎた手動の更新は取り直す。その応答が 429
		harness.now += 3 * MINUTE;
		harness.responses.push({ status: 429, headers: { 'retry-after': '120' } });
		const limited = summarize(await harness.reader.getState({ refresh: true }));
		const afterLimited = harness.calls.length;
		// 待っている間は手動の更新でも呼ばない
		harness.now += MINUTE;
		await harness.reader.getState({ refresh: true });

		assert.deepStrictEqual({ afterFirst, afterLimited, total: harness.calls.length, limitedStatus: (limited as { status: string; fiveHour: number | undefined }[]).map(account => [account.status, account.fiveHour]) }, {
			afterFirst: 1,
			afterLimited: 2,
			total: 2,
			// 前に取れた値はそのまま見せ続ける
			limitedStatus: [['ok', 42]],
		});
	});

	test('CLAUDE_CONFIG_DIR of the REH process: reads the login from that folder', async () => {
		const harness = await createHarness({ configDir: home => path.join(home, 'custom-claude') });
		const configDir = path.join(harness.home, 'custom-claude');
		await fs.promises.mkdir(configDir, { recursive: true });
		await fs.promises.writeFile(path.join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: paradisTestOauthAccount('u-c', 'custom@example.com') }));
		await writeCredentials(configDir, 'custom-access', harness.now + HOUR);
		// 既定の場所にある別のログインは見ない
		await paradisWriteClaudeGlobalConfig(harness.home, { oauthAccount: paradisTestOauthAccount('u-d', 'default@example.com') });
		await writeCredentials(path.join(harness.home, '.claude'), 'default-access', harness.now + HOUR);

		const state = summarize(await harness.reader.getState(undefined));

		assert.deepStrictEqual({ state, calls: harness.calls.map(call => call.authorization) }, {
			state: [{ id: 'claude-host', email: 'custom@example.com', homeLabel: configDir, status: 'ok', unavailableReason: undefined, fiveHour: 42, sevenDay: 10, scoped: ['Fable:7'], active: undefined, managed: undefined, registrable: undefined }],
			calls: ['Bearer custom-access'],
		});
	});
});
