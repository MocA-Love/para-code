/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisMobileWarmLeaseScheduler, ParadisMobileWarmLeaseProvider, paradisResolveLocalAgentPaneCwd, paradisScreenShowsMarker } from '../../electron-browser/paradisMobileWorkspaceProvider.js';
import { parseParadisMobileWarmLeaseRequest } from '../../common/paradisMobileProtocol.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';

class TestWarmLeaseScheduler implements IParadisMobileWarmLeaseScheduler {
	private scheduled = false;

	constructor(private readonly runner: () => void) { }

	schedule(): void {
		this.scheduled = true;
	}

	cancel(): void {
		this.scheduled = false;
	}

	fire(): void {
		if (!this.scheduled) {
			return;
		}
		this.scheduled = false;
		this.runner();
	}

	dispose(): void {
		this.cancel();
	}
}

function warmRequest(t: 'usageWarmLease' | 'spaceDiskWarmLease', leaseId: string, active: boolean) {
	return {
		t,
		leaseId,
		active,
		desktopEpoch: 'desktop-epoch',
		windowId: 7,
		rendererGeneration: 11,
	} as const;
}

suite('ParadisMobileWorkspaceProvider', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('uses shell-integration cwd when available', async () => {
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: undefined,
			getCwdResource: async () => URI.file('/workspace/detected'),
			getSpeculativeCwd: async () => '/workspace/speculative',
		}), URI.file('/workspace/detected').fsPath);
	});

	test('falls back to speculative cwd for a local terminal without shell integration', async () => {
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: undefined,
			getCwdResource: async () => undefined,
			getSpeculativeCwd: async () => '/workspace/naive',
		}), '/workspace/naive');
	});

	test('does not report a local path for a remote terminal', async () => {
		let speculativeCalls = 0;
		assert.strictEqual(await paradisResolveLocalAgentPaneCwd({
			remoteAuthority: 'ssh-remote+host',
			getCwdResource: async () => undefined,
			getSpeculativeCwd: async () => { speculativeCalls++; return '/remote/workspace'; },
		}), undefined);
		assert.strictEqual(speculativeCalls, 0);
	});

	suite('質問が描かれたかの照合', () => {
		test('折り返しの改行と空白を無視して目印を探す', () => {
			// ターミナルは幅で折り返し、境目に改行が入る。Para Code は2Dグリッドで狭いペインが
			// 常態なので、素朴な部分一致だと日本語ラベルはほぼ必ず外れる。
			assert.deepStrictEqual({
				wrapped: paradisScreenShowsMarker('❯ 1. キャッシュ\nを使う\n  2. 作り直す', 'キャッシュを使う'),
				spaced: paradisScreenShowsMarker('❯ 1. Use the cached build', 'Usethecached'),
				absent: paradisScreenShowsMarker('❯ 1. まったく別の選択肢', 'キャッシュを使う'),
				empty: paradisScreenShowsMarker('', 'Alpha'),
			}, {
				wrapped: true,
				spaced: true,
				absent: false,
				empty: false,
			});
		});
	});

	suite('warm lease bridge', () => {
		test('accepts only the exact generation-bound wire payload', () => {
			const valid = warmRequest('usageWarmLease', 'lease-1', true);
			assert.deepStrictEqual(parseParadisMobileWarmLeaseRequest(valid), { kind: 'valid', request: valid });
			for (const malformed of [
				{ ...valid, extra: true },
				{ ...valid, rendererGeneration: undefined },
				{ ...valid, desktopEpoch: '' },
				{ ...valid, leaseId: 'bad owner' },
				{ ...valid, active: 1 },
			]) {
				assert.deepStrictEqual(parseParadisMobileWarmLeaseRequest(malformed), { kind: 'invalid' });
			}
			assert.deepStrictEqual(parseParadisMobileWarmLeaseRequest({ t: 'usage', id: 'foreground' }), { kind: 'not-warm' });
		});

		test('namespaces owners and renews one owner without consuming another slot', async () => {
			const calls: { resource: string; ownerId: string; active: boolean }[] = [];
			const provider = new ParadisMobileWarmLeaseProvider(
				(ownerId, active) => { calls.push({ resource: 'ccusage', ownerId, active }); return Promise.resolve(); },
				(ownerId, active) => { calls.push({ resource: 'spaceDisk', ownerId, active }); return Promise.resolve(); },
			);
			try {
				await provider.setLease('mobile-a', warmRequest('usageWarmLease', 'lease-1', true));
				await provider.setLease('mobile-a', warmRequest('usageWarmLease', 'lease-1', true));
				await provider.setLease('mobile-b', warmRequest('spaceDiskWarmLease', 'lease-1', true));
				assert.deepStrictEqual(calls, [
					{ resource: 'ccusage', ownerId: 'mobile-a:ccusage:lease-1', active: true },
					{ resource: 'ccusage', ownerId: 'mobile-a:ccusage:lease-1', active: true },
					{ resource: 'spaceDisk', ownerId: 'mobile-b:spaceDisk:lease-1', active: true },
				]);
			} finally {
				provider.dispose();
			}
		});

		test('purges expired owners before the 128 owner cap and releases on expiry and dispose', async () => {
			let now = 0;
			let scheduler!: TestWarmLeaseScheduler;
			const calls: { ownerId: string; active: boolean }[] = [];
			const provider = new ParadisMobileWarmLeaseProvider(
				(ownerId, active) => { calls.push({ ownerId, active }); return Promise.resolve(); },
				(ownerId, active) => { calls.push({ ownerId, active }); return Promise.resolve(); },
				() => now,
				runner => scheduler = new TestWarmLeaseScheduler(runner),
			);
			await provider.setLease('expired-mobile', warmRequest('usageWarmLease', 'expired', true));
			now = 900_001;
			for (let index = 0; index < 128; index++) {
				await provider.setLease(`mobile-${index}`, warmRequest('usageWarmLease', `lease-${index}`, true));
			}
			await provider.setLease('overflow-mobile', warmRequest('usageWarmLease', 'overflow', true));
			assert.strictEqual(calls.filter(call => call.active).length, 129);
			assert.deepStrictEqual(calls.find(call => call.ownerId === 'expired-mobile:ccusage:expired' && !call.active), {
				ownerId: 'expired-mobile:ccusage:expired', active: false,
			});
			now = 1_800_002;
			scheduler.fire();
			await Promise.resolve();
			provider.dispose();
			await Promise.resolve();
			assert.strictEqual(calls.filter(call => !call.active).length, 129);
		});

		test('serializes a release behind a pending acquire', async () => {
			let finishAcquire!: () => void;
			const acquireBarrier = new Promise<void>(resolve => finishAcquire = resolve);
			const operations: string[] = [];
			const backendOwners = new Set<string>();
			const provider = new ParadisMobileWarmLeaseProvider(
				async (ownerId, active) => {
					operations.push(active ? 'acquire:start' : 'release');
					if (active) {
						await acquireBarrier;
						backendOwners.add(ownerId);
						operations.push('acquire:end');
					} else {
						backendOwners.delete(ownerId);
					}
				},
				() => Promise.resolve(),
			);
			const acquire = provider.setLease('mobile-a', warmRequest('usageWarmLease', 'slow', true));
			await Promise.resolve();
			const release = provider.setLease('mobile-a', warmRequest('usageWarmLease', 'slow', false));
			assert.deepStrictEqual(operations, ['acquire:start']);
			finishAcquire();
			await Promise.all([acquire, release]);
			assert.deepStrictEqual(operations, ['acquire:start', 'acquire:end', 'release']);
			assert.strictEqual(backendOwners.size, 0);
			provider.dispose();
		});

		test('serializes provider dispose behind a pending space disk acquire', async () => {
			let finishAcquire!: () => void;
			const acquireBarrier = new Promise<void>(resolve => finishAcquire = resolve);
			const operations: string[] = [];
			const provider = new ParadisMobileWarmLeaseProvider(
				() => Promise.resolve(),
				async (_ownerId, active) => {
					operations.push(active ? 'acquire:start' : 'release');
					if (active) {
						await acquireBarrier;
						operations.push('acquire:end');
					}
				},
			);
			const acquire = provider.setLease('mobile-a', warmRequest('spaceDiskWarmLease', 'slow', true));
			await Promise.resolve();
			provider.dispose();
			assert.deepStrictEqual(operations, ['acquire:start']);
			finishAcquire();
			await acquire;
			assert.deepStrictEqual(operations, ['acquire:start', 'acquire:end', 'release']);
		});

		test('reports failed backend actions and retries an acquire on the next mobile heartbeat', async () => {
			const acquireError = new Error('acquire unavailable');
			const releaseError = new Error('release unavailable');
			const calls: boolean[] = [];
			const failures: { operation: string; error: unknown; extra: Record<string, unknown> | undefined }[] = [];
			let failAcquire = true;
			configureParadisDiagnosticReporter((_scope, _feature, operation, error, extra) => failures.push({ operation, error, extra }));
			const provider = new ParadisMobileWarmLeaseProvider(
				async (_ownerId, active) => {
					calls.push(active);
					if (active && failAcquire) {
						failAcquire = false;
						throw acquireError;
					}
					if (!active) {
						throw releaseError;
					}
				},
				() => Promise.resolve(),
			);
			try {
				await provider.setLease('mobile-a', warmRequest('usageWarmLease', 'retry', true));
				assert.deepStrictEqual(calls, [true]);
				assert.deepStrictEqual(failures, [{
					operation: 'backend-acquire', error: acquireError,
					extra: { safe_action: 'acquire', safe_resource: 'ccusage', safe_owner_id: 'mobile-a:ccusage:retry' },
				}]);

				await provider.setLease('mobile-a', warmRequest('usageWarmLease', 'retry', true));
				assert.deepStrictEqual(calls, [true, true]);
				await provider.setLease('mobile-a', warmRequest('usageWarmLease', 'retry', false));
				assert.deepStrictEqual(failures, [
					{
						operation: 'backend-acquire', error: acquireError,
						extra: { safe_action: 'acquire', safe_resource: 'ccusage', safe_owner_id: 'mobile-a:ccusage:retry' },
					},
					{
						operation: 'backend-release', error: releaseError,
						extra: { safe_action: 'release', safe_resource: 'ccusage', safe_owner_id: 'mobile-a:ccusage:retry' },
					},
				]);
			} finally {
				provider.dispose();
				configureParadisDiagnosticReporter(() => { });
			}
		});
	});
});
