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
import type { IParadisLimitsWindow } from '../../common/paradisLimitsMonitor.js';
import { ICodexAccountResult, IWhamUsageResponse, ParadisLimitsMonitorService } from '../../node/paradisLimitsMonitorChannel.js';

type ParadisFakeRpcAnswer = { readonly email?: string; readonly planType?: string; readonly windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } } | Error;

class ParadisFakeCodexUsageService extends ParadisLimitsMonitorService {
	readonly calls: string[] = [];
	rpcAnswer: ParadisFakeRpcAnswer = { email: 'rpc@example.com', planType: 'plus', windows: { fiveHour: { usedPercent: 10 }, sevenDay: { usedPercent: 20 } } };
	whamAnswer: IWhamUsageResponse | Error = {
		plan_type: 'pro',
		rate_limit: { primary_window: { used_percent: 55, limit_window_seconds: 18_000 }, secondary_window: { used_percent: 66, limit_window_seconds: 604_800 } },
		additional_rate_limits: [{ limit_name: 'codex-spark', rate_limit: { primary_window: { used_percent: 5 } } }],
	};

	protected override async fetchCodexAccountViaRpc(homePath: string): Promise<{ email?: string; planType?: string; windows: { fiveHour?: IParadisLimitsWindow; sevenDay?: IParadisLimitsWindow } }> {
		this.calls.push(`rpc:${homePath}`);
		if (this.rpcAnswer instanceof Error) {
			throw this.rpcAnswer;
		}
		return this.rpcAnswer;
	}

	protected override async fetchWhamUsage(): Promise<IWhamUsageResponse> {
		this.calls.push('wham');
		if (this.whamAnswer instanceof Error) {
			throw this.whamAnswer;
		}
		return this.whamAnswer;
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

	test('reads the app-server first and adds only the extra windows from wham/usage', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		const result = await service.fetch(codexHome);
		service.dispose();
		assert.deepStrictEqual({ result: summary(result), calls: service.calls }, {
			result: { status: 'ok', email: 'rpc@example.com', planType: 'plus', fiveHour: 10, sevenDay: 20, scoped: ['codex-spark'], statusDetail: undefined },
			calls: [`rpc:${codexHome}`, 'wham'],
		});
	});

	// Orca の supplementCodexSessionWindow と同じく、RPC に5時間の枠が無く週の枠だけなら wham/usage で埋める。
	test('fills a missing five-hour window from wham/usage when the app-server only returned the weekly one', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		service.rpcAnswer = { planType: 'plus', windows: { sevenDay: { usedPercent: 20 } } };
		const filled = summary(await service.fetch(codexHome));
		service.whamAnswer = httpError(401);
		const kept = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ filled, kept }, {
			filled: { status: 'ok', email: undefined, planType: 'plus', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			kept: { status: 'ok', email: undefined, planType: 'plus', fiveHour: undefined, sevenDay: 20, scoped: undefined, statusDetail: undefined },
		});
	});

	test('falls back to wham/usage when the app-server fails, and skips the app-server for a while after that', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		service.rpcAnswer = new Error('codex app-server exited (code=1, signal=null)');
		const first = summary(await service.fetch(codexHome));
		const second = summary(await service.fetch(codexHome));
		service.whamAnswer = httpError(401);
		const expired = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ first, second, expired: expired.status, calls: service.calls }, {
			first: { status: 'ok', email: undefined, planType: 'pro', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			second: { status: 'ok', email: undefined, planType: 'pro', fiveHour: 55, sevenDay: 66, scoped: ['codex-spark'], statusDetail: undefined },
			expired: 'relogin_required',
			calls: [`rpc:${codexHome}`, 'wham', 'wham', 'wham'],
		});
	});

	// 認証切れは再ログインでしか直らないので、wham/usage へは落ちない（Orca も同じ）。
	test('reports re-login without falling back when the app-server says authentication is required', async () => {
		const service = new ParadisFakeCodexUsageService(new NullLogService(), undefined, undefined, () => root);
		service.rpcAnswer = new Error('codex account authentication required to read rate limits');
		const result = summary(await service.fetch(codexHome));
		service.dispose();
		assert.deepStrictEqual({ status: result.status, calls: service.calls }, { status: 'relogin_required', calls: [`rpc:${codexHome}`] });
	});
});
