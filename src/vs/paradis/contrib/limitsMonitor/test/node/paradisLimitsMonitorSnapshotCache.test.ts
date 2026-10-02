/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisLimitsAccount, IParadisLimitsSnapshot } from '../../common/paradisLimitsMonitor.js';
import { ICodexAccountResult, ParadisLimitsMonitorService, paradisHashCodexAccountId, paradisIsTransientCodexSnapshotFailure } from '../../node/paradisLimitsMonitorChannel.js';

const TTL_MS = 150_000;

class TestLimitsMonitorService extends ParadisLimitsMonitorService {
	fetches = 0;
	release: (() => void) | undefined;
	hold = false;
	failing = false;

	protected override async fetchCodexAccount(homePath: string): Promise<ICodexAccountResult> {
		this.fetches++;
		const round = this.fetches;
		if (this.hold) {
			await new Promise<void>(resolve => { this.release = resolve; });
		}
		if (this.failing) {
			return { account: { provider: 'codex', id: homePath, status: 'error', statusDetail: 'network down' }, accountId: 'account-1' };
		}
		return {
			account: { provider: 'codex', id: homePath, email: `round-${round}@example.com`, status: 'ok' },
			accountId: 'account-1',
		};
	}
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
		await new Promise(resolve => setImmediate(resolve));
	}
}

suite('ParadisLimitsMonitorService snapshot cache', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let codexHome: string | undefined;

	setup(() => {
		// 走査は CODEX_HOME も足すので、テストの間は外す（実行環境のホームを読ませない）
		codexHome = process.env['CODEX_HOME'];
		delete process.env['CODEX_HOME'];
		root = mkdtempSync(join(tmpdir(), 'paradis-limits-snapshot-'));
		mkdirSync(join(root, '.codex'));
		writeFileSync(join(root, '.codex', 'auth.json'), '{}');
	});

	teardown(() => {
		if (codexHome !== undefined) {
			process.env['CODEX_HOME'] = codexHome;
		}
		sinon.restore();
		rmSync(root, { recursive: true, force: true });
	});

	// TTL を過ぎても前回の値をすぐ返し（stale）、裏で1回だけ取り直す。account_id はスマホが束ねる鍵として返す。
	test('serves an expired snapshot as stale while refreshing it in the background', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const service = new TestLimitsMonitorService(new NullLogService(), undefined, undefined, () => root);
		const summary = (snapshot: Awaited<ReturnType<ParadisLimitsMonitorService['getSnapshot']>>) => ({
			email: snapshot.codex.accounts[0]?.email,
			accountId: snapshot.codex.accounts[0]?.accountId,
			fetchedAt: snapshot.fetchedAt - 1_000_000,
			stale: snapshot.stale === true,
		});

		const first = summary(await service.getSnapshot({}));
		clock.setSystemTime(1_000_000 + TTL_MS);
		service.hold = true;
		const expired = summary(await service.getSnapshot({}));
		const whileRefreshing = summary(await service.getSnapshot({}));
		await waitFor(() => service.release !== undefined);
		service.release!();
		await waitFor(() => service.fetches === 2 && !(service as unknown as { inflight: unknown }).inflight);
		const refreshed = summary(await service.getSnapshot({}));
		service.dispose();

		assert.deepStrictEqual({ fetches: service.fetches, results: [first, expired, whileRefreshing, refreshed] }, {
			fetches: 2,
			results: [
				{ email: 'round-1@example.com', accountId: paradisHashCodexAccountId('account-1'), fetchedAt: 0, stale: false },
				{ email: 'round-1@example.com', accountId: paradisHashCodexAccountId('account-1'), fetchedAt: 0, stale: true },
				{ email: 'round-1@example.com', accountId: paradisHashCodexAccountId('account-1'), fetchedAt: 0, stale: true },
				{ email: 'round-2@example.com', accountId: paradisHashCodexAccountId('account-1'), fetchedAt: TTL_MS, stale: false },
			],
		});
	});

	// 手動更新（bypassCache）は前回の値を返さず、取り終えるまで待つ。
	test('waits for a fresh snapshot on an explicit refresh', async () => {
		sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const service = new TestLimitsMonitorService(new NullLogService(), undefined, undefined, () => root);

		await service.getSnapshot({});
		const refreshed = await service.getSnapshot({ bypassCache: true });
		service.dispose();

		assert.deepStrictEqual({ fetches: service.fetches, email: refreshed.codex.accounts[0]?.email, stale: refreshed.stale }, { fetches: 2, email: 'round-2@example.com', stale: undefined });
	});

	// 6 時間より古いスナップショットは古い値としても返さず、取り終えるまで待つ。
	test('waits for a fresh snapshot once the cached one is too old to serve as stale', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const service = new TestLimitsMonitorService(new NullLogService(), undefined, undefined, () => root);

		await service.getSnapshot({});
		clock.setSystemTime(1_000_000 + 6 * 60 * 60_000);
		const refreshed = await service.getSnapshot({});
		service.dispose();

		assert.deepStrictEqual({ fetches: service.fetches, email: refreshed.codex.accounts[0]?.email, stale: refreshed.stale }, { fetches: 2, email: 'round-2@example.com', stale: undefined });
	});

	// 全ホームが一時的に失敗したら前回の値を残し（古い値として出し続ける）、取り直しの間隔を 1 分から伸ばす。
	test('keeps the previous snapshot when every Codex home fails and backs off the refresh', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const service = new TestLimitsMonitorService(new NullLogService(), undefined, undefined, () => root);

		await service.getSnapshot({});
		service.failing = true;
		clock.setSystemTime(1_000_000 + TTL_MS);
		await service.getSnapshot({});
		await waitFor(() => service.fetches === 2 && !(service as unknown as { inflight: unknown }).inflight);
		await waitFor(() => (service as unknown as { snapshotRefreshFailure: unknown }).snapshotRefreshFailure !== undefined);
		clock.setSystemTime(1_000_000 + TTL_MS + 60_000 - 1);
		const withinBackoff = await service.getSnapshot({});
		const fetchesWithinBackoff = service.fetches;
		clock.setSystemTime(1_000_000 + TTL_MS + 60_000);
		await service.getSnapshot({});
		await waitFor(() => service.fetches === 3);
		service.dispose();

		assert.deepStrictEqual({
			withinBackoff: [withinBackoff.codex.accounts[0]?.email, withinBackoff.stale],
			fetches: [fetchesWithinBackoff, service.fetches],
		}, {
			withinBackoff: ['round-1@example.com', true],
			fetches: [2, 3],
		});
	});

	// 古い値として出せないほど古い前回の値は、一時的な失敗の結果で上書きし、その失敗も TTL の間キャッシュする
	// （要求のたびに app-server を起こさない）。
	test('replaces a too-old snapshot with the failure and caches the failure for the TTL', async () => {
		const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
		const service = new TestLimitsMonitorService(new NullLogService(), undefined, undefined, () => root);

		await service.getSnapshot({});
		service.failing = true;
		clock.setSystemTime(1_000_000 + 6 * 60 * 60_000);
		const failed = await service.getSnapshot({});
		clock.setSystemTime(1_000_000 + 6 * 60 * 60_000 + TTL_MS - 1);
		const cachedFailure = await service.getSnapshot({});
		service.dispose();

		assert.deepStrictEqual({
			fetches: service.fetches,
			statuses: [failed.codex.accounts[0]?.status, cachedFailure.codex.accounts[0]?.status],
			stale: cachedFailure.stale,
		}, { fetches: 2, statuses: ['error', 'error'], stale: undefined });
	});

	// 一時的と数えるのは error と、unavailable のうち時間が経てば戻るもの（host_fetch_failed・rate_limited）だけ。
	test('counts only error and recoverable unavailable accounts as a transient failure', () => {
		const snapshot = (...accounts: Array<Partial<IParadisLimitsAccount>>): IParadisLimitsSnapshot => ({
			claude: { accounts: [] },
			codex: { accounts: accounts.map((account, index) => ({ provider: 'codex', id: `home-${index}`, status: 'ok', ...account })) },
			fetchedAt: 0,
		});
		assert.deepStrictEqual([
			paradisIsTransientCodexSnapshotFailure(snapshot({ status: 'error' }, { status: 'unavailable', unavailableReason: 'host_fetch_failed' }, { status: 'unavailable', unavailableReason: 'rate_limited' })),
			paradisIsTransientCodexSnapshotFailure(snapshot({ status: 'error' }, { status: 'unavailable', unavailableReason: 'api_key' })),
			paradisIsTransientCodexSnapshotFailure(snapshot({ status: 'error' }, { status: 'relogin_required' })),
			paradisIsTransientCodexSnapshotFailure(snapshot({ status: 'error' }, { status: 'ok' })),
			paradisIsTransientCodexSnapshotFailure(snapshot()),
		], [true, false, false, false, false]);
	});
});
