/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex の使用量は Orca と同じく codex app-server の RPC から先に取り、取れないときだけ wham/usage を使う。
// RPC と wham/usage はどちらも差し替え、本物の codex・chatgpt.com・~/.codex には触れない。

import assert from 'assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import type { IParadisLimitsWindow } from '../../common/paradisLimitsMonitor.js';
import { ICodexAccountResult, IWhamUsageResponse, ParadisLimitsMonitorService } from '../../node/paradisLimitsMonitorChannel.js';

type ParadisFakeRpcAnswer = { readonly email?: string; readonly planType?: string; readonly windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } } | Error;

class ParadisFakeCodexUsageService extends ParadisLimitsMonitorService {
	readonly calls: string[] = [];
	clock = 1_000_000;
	/** RPC の中で codex がトークンを更新したことにする（auth.json を書き換える）。 */
	onRpc: (() => void) | undefined;
	rpcAnswer: ParadisFakeRpcAnswer = { email: 'rpc@example.com', planType: 'plus', windows: { fiveHour: { usedPercent: 10 }, sevenDay: { usedPercent: 20 } } };
	whamAnswer: IWhamUsageResponse | Error = {
		plan_type: 'pro',
		rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 66, limit_window_seconds: 604_800 } },
		additional_rate_limits: [{ limit_name: 'codex-spark', rate_limit: { primary_window: { used_percent: 5 } } }],
	};

	protected override async fetchCodexAccountViaRpc(homePath: string): Promise<{ email?: string; planType?: string; windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } }> {
		this.calls.push(`rpc:${homePath}`);
		this.onRpc?.();
		if (this.rpcAnswer instanceof Error) {
			throw this.rpcAnswer;
		}
		return this.rpcAnswer;
	}

	protected override async fetchWhamUsage(accessToken: string): Promise<IWhamUsageResponse> {
		this.calls.push(`wham:${accessToken}`);
		if (this.whamAnswer instanceof Error) {
			throw this.whamAnswer;
		}
		return this.whamAnswer;
	}

	protected override now(): number {
		return this.clock;
	}

	protected override async delay(): Promise<void> {
		this.calls.push('stagger');
	}

	fetch(homePath: string): Promise<ICodexAccountResult> {
		return this.fetchCodexAccount(homePath);
	}
}

function httpError(status: number): Error {
	return Object.assign(new Error(`Codex usage API returned ${status}`), { httpStatus: status });
}

suite('ParadisLimitsMonitor Codex usage order', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let root: string;
	let codexHome: string;

	setup(() => {
		root = mkdtempSync(join(tmpdir(), 'paradis-codex-usage-'));
		codexHome = join(root, '.codex');
		mkdirSync(codexHome);
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-token', account_id: 'acct-1' } }));
	});

	teardown(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function summary(result: ICodexAccountResult) {
		const { status, email, planType, fiveHour, sevenDay, scoped, statusDetail } = result.account;
		return { status, email, planType, fiveHour: fiveHour?.usedPercent, sevenDay: sevenDay?.usedPercent, scoped: scoped?.map(window => window.label), statusDetail };
	}

	test('reads the app-server first, adds only the extra windows from wham/usage, and waits 5 minutes before the next app-server', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		const first = summary(await service.fetch(codexHome));
		service.clock += 60_000;
		const within = summary(await service.fetch(codexHome));
		service.clock += 5 * 60_000;
		await service.fetch(codexHome);
		service.dispose();
		assert.deepStrictEqual({ first, within, calls: service.calls }, {
			first: { status: 'ok', email: 'rpc@example.com', planType: 'plus', fiveHour: 10, sevenDay: 20, scoped: ['codex-spark'], statusDetail: undefined },
			// 5 分以内は app-server を起こさず、wham/usage だけで読む
			within: { status: 'ok', email: undefined, planType: 'pro', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			calls: [`rpc:${codexHome}`, 'wham:test-token', 'wham:test-token', `rpc:${codexHome}`, 'wham:test-token'],
		});
	});

	// Orca の supplementCodexSessionWindow と同じく、RPC に5時間の枠が無く週の枠だけなら wham/usage で埋める。
	// codex が RPC の中でトークンを更新したら、足す分は新しいトークンで読む。
	test('fills a missing five-hour window from wham/usage with the token codex refreshed during the RPC', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		service.rpcAnswer = { planType: 'plus', windows: { sevenDay: { usedPercent: 20 } } };
		service.onRpc = () => writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'refreshed-token', account_id: 'acct-1' } }));
		const filled = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ filled, calls: service.calls }, {
			filled: { status: 'ok', email: undefined, planType: 'plus', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			calls: [`rpc:${codexHome}`, 'wham:refreshed-token'],
		});
	});

	// 認証切れ以外で RPC に失敗したら wham/usage で読み、10 分間は RPC を飛ばす。その間の 401 は、codex で
	// 更新できないだけなので「要再ログイン」にしない（以前と同じ）。
	test('falls back to wham/usage when the app-server fails, and does not ask to re-login for a 401 while skipping it', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		service.rpcAnswer = new Error('codex app-server exited (code=1, signal=null)');
		const first = summary(await service.fetch(codexHome));
		service.clock += 6 * 60_000;
		const second = summary(await service.fetch(codexHome));
		service.whamAnswer = httpError(401);
		const expired = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ first, second, expired: [expired.status, expired.statusDetail], calls: service.calls }, {
			first: { status: 'ok', email: undefined, planType: 'pro', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			second: { status: 'ok', email: undefined, planType: 'pro', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			expired: ['error', 'access token expired and codex app-server is unavailable to refresh it'],
			calls: [`rpc:${codexHome}`, 'wham:test-token', 'wham:test-token', 'wham:test-token'],
		});
	});

	// wham/usage の 401 は、アクセストークンの期限が切れただけかもしれない。5 分の間隔を待たずに codex に更新させる。
	test('lets codex refresh an expired access token right away when wham/usage returns 401 between app-server reads', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		await service.fetch(codexHome);
		service.clock += 60_000;
		service.whamAnswer = httpError(401);
		const result = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ status: result.status, calls: service.calls }, {
			status: 'ok',
			calls: [`rpc:${codexHome}`, 'wham:test-token', 'wham:test-token', `rpc:${codexHome}`, 'wham:test-token'],
		});
	});

	// 認証切れは再ログインでしか直らないので、wham/usage へは落ちない（Orca も同じ）。ログインし直すか 10 分たつまで
	// app-server を起こさない。
	test('reports re-login when the app-server says authentication is required, and waits for a new login before trying again', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		service.rpcAnswer = new Error('codex account authentication required to read rate limits');
		const first = summary(await service.fetch(codexHome));
		service.clock += 6 * 60_000;
		service.whamAnswer = httpError(401);
		const waiting = summary(await service.fetch(codexHome));
		// ログインし直した（auth.json が変わった）
		writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'new-login', account_id: 'acct-1' } }));
		service.rpcAnswer = { planType: 'plus', windows: { fiveHour: { usedPercent: 1 }, sevenDay: { usedPercent: 2 } } };
		service.whamAnswer = { plan_type: 'plus' };
		const relogged = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ statuses: [first.status, waiting.status, relogged.status], calls: service.calls }, {
			statuses: ['relogin_required', 'relogin_required', 'ok'],
			calls: [`rpc:${codexHome}`, 'wham:test-token', `rpc:${codexHome}`, 'wham:new-login'],
		});
	});

	// ホームが複数あっても、app-server は1つずつ、前のものが終わってから 2 秒あけて起こす。
	test('starts app-servers for several homes one at a time with a stagger', async () => {
		const secondHome = join(root, '.codex-2');
		mkdirSync(secondHome);
		writeFileSync(join(secondHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'second-token', account_id: 'acct-2' } }));
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		await Promise.all([service.fetch(codexHome), service.fetch(secondHome)]);
		service.dispose();
		assert.deepStrictEqual(service.calls.filter(call => !call.startsWith('wham:')), [`rpc:${codexHome}`, 'stagger', `rpc:${secondHome}`]);
	});

	// app-server の失敗は、wham/usage で出せたなら報告しない。両方だめなときだけ、ホームごとに1回報告する。
	test('reports an app-server failure only when wham/usage also fails, once per home', async () => {
		const reports: string[] = [];
		configureParadisDiagnosticReporter((_scope, _feature, operation, _error, safeExtra) => reports.push(`${operation}:${safeExtra?.safe_error_kind}`));
		try {
			const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
			service.rpcAnswer = new Error('codex app-server exited (code=1, signal=null)');
			const whamWorked = summary(await service.fetch(codexHome)).status;
			const afterWhamWorked = [...reports];
			service.clock += 11 * 60_000;
			service.whamAnswer = httpError(500);
			const bothFailed = summary(await service.fetch(codexHome)).status;
			service.clock += 11 * 60_000;
			await service.fetch(codexHome);
			service.dispose();
			assert.deepStrictEqual({ whamWorked, afterWhamWorked, bothFailed, reports }, {
				whamWorked: 'ok',
				afterWhamWorked: [],
				bothFailed: 'error',
				reports: ['codex-app-server-fallback:exited'],
			});
		} finally {
			configureParadisDiagnosticReporter(() => { });
		}
	});
});
