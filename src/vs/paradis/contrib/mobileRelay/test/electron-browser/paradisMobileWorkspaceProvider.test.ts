/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { ParadisMobileRelayRendererLifecycle } from '../../electron-browser/paradisMobileRelayRendererLifecycle.js';
import { IParadisMobileWarmLeaseScheduler, ParadisMobileWarmLeaseProvider, ParadisMobileWorkspaceProvider, paradisResolveLocalAgentPaneCwd, paradisScreenShowsMarker } from '../../electron-browser/paradisMobileWorkspaceProvider.js';
import { parseParadisMobileWarmLeaseRequest } from '../../common/paradisMobileProtocol.js';
import { configureParadisDiagnosticReporter } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { IParadisWorkspaceRepository, IParadisWorktree } from '../../../workspaceSwitch/common/paradisWorkspaceSwitch.js';
import { IParadisPrStatus } from '../../../workspaceSwitch/common/paradisWorktreeCreate.js';

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

class StatePushMetricsTimer {
	private callback: (() => void) | undefined;
	readonly callbacks: Array<() => void> = [];
	readonly intervals: number[] = [];

	cancel(): void {
		this.callback = undefined;
	}

	cancelAndSet(callback: () => void, interval: number): void {
		this.callback = callback;
		this.callbacks.push(callback);
		this.intervals.push(interval);
	}

	fire(): void {
		this.callback?.();
	}

	fireQueued(index: number): void {
		this.callbacks[index]?.();
	}

	get active(): boolean {
		return this.callback !== undefined;
	}
}

interface IStatePushMetricsProviderFixture {
	setStatePushMetricsEnabled(enabled: boolean): void;
}

class RecordingStatePushMetricsProvider {
	readonly enabledCalls: boolean[] = [];

	constructor(private readonly events?: string[]) {
	}

	setStatePushMetricsEnabled(enabled: boolean): void {
		this.events?.push(`metrics:${enabled}`);
		this.enabledCalls.push(enabled);
	}
}

function createStatePushMetricsProviderFixture(): { provider: IStatePushMetricsProviderFixture; timer: StatePushMetricsTimer; logs: string[]; state: { pushStateCalls: number; pushStateSkipped: number; snapshotMetrics: Map<string, { count: number; maxChars: number; totalChars: number }> } } {
	const timer = new StatePushMetricsTimer();
	const logs: string[] = [];
	const initialState = {
		pushStateCalls: 0,
		pushStateSkipped: 0,
		snapshotMetrics: new Map<string, { count: number; maxChars: number; totalChars: number }>(),
	};
	const provider = Object.assign(Object.create(ParadisMobileWorkspaceProvider.prototype) as object, {
		statePushMetricsTimer: timer,
		statePushMetricsEnabled: false,
		statePushMetricsGeneration: 0,
		...initialState,
		lastPushedSnapshot: undefined,
		allInstances: () => [],
		logService: { info: (message: string) => logs.push(message) },
	}) as unknown as IStatePushMetricsProviderFixture;
	const state = provider as unknown as IStatePushMetricsProviderFixture & typeof initialState;
	return { provider, timer, logs, state };
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

		test('counts never-settling retiring operations in a resource-scoped owner quota', async () => {
			const pending = new Promise<void>(() => { });
			const calls: { resource: string; active: boolean }[] = [];
			const provider = new ParadisMobileWarmLeaseProvider(
				(_ownerId, active) => { calls.push({ resource: 'ccusage', active }); return pending; },
				(_ownerId, active) => { calls.push({ resource: 'spaceDisk', active }); return Promise.resolve(); },
			);

			for (let index = 0; index < 128; index++) {
				void provider.setLease(`mobile-${index}`, warmRequest('usageWarmLease', `lease-${index}`, true));
			}
			for (let index = 0; index < 128; index++) {
				void provider.setLease(`mobile-${index}`, warmRequest('usageWarmLease', `lease-${index}`, false));
			}
			void provider.setLease('overflow-mobile', warmRequest('usageWarmLease', 'overflow', true));
			await provider.setLease('space-mobile', warmRequest('spaceDiskWarmLease', 'independent', true));

			assert.deepStrictEqual({
				ccusageCalls: calls.filter(call => call.resource === 'ccusage').length,
				spaceDiskCalls: calls.filter(call => call.resource === 'spaceDisk').length,
			}, { ccusageCalls: 128, spaceDiskCalls: 1 });
			provider.dispose();
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

	suite('state push metrics', () => {
		test('constructs the provider before synchronizing initially disabled renderer metrics', () => {
			const events: string[] = [];
			const focusHeartbeat = {
				setEnabled: (enabled: boolean) => events.push(`focus:${enabled}`),
				setEnabledAndSynchronize: (enabled: boolean) => events.push(`focus-shared:${enabled}`),
			};
			const lifecycle = new ParadisMobileRelayRendererLifecycle(
				focusHeartbeat,
				() => {
					events.push('provider');
					return new RecordingStatePushMetricsProvider(events);
				},
				false,
			);

			assert.deepStrictEqual({ events, metricsEnabledCalls: lifecycle.provider.enabledCalls }, {
				events: ['provider', 'focus:false', 'metrics:false'],
				metricsEnabledCalls: [false],
			});
		});

		test('synchronizes initially enabled and changed settings with the provider metrics delegate', () => {
			const events: string[] = [];
			const focusHeartbeat = {
				setEnabled: (enabled: boolean) => events.push(`focus:${enabled}`),
				setEnabledAndSynchronize: (enabled: boolean) => events.push(`focus-shared:${enabled}`),
			};
			const lifecycle = new ParadisMobileRelayRendererLifecycle(
				focusHeartbeat,
				() => new RecordingStatePushMetricsProvider(),
				true,
			);

			lifecycle.setEnabled(false);
			lifecycle.setEnabled(true);

			assert.deepStrictEqual({ events, metricsEnabledCalls: lifecycle.provider.enabledCalls }, {
				events: ['focus:true', 'focus-shared:false', 'focus-shared:true'],
				metricsEnabledCalls: [true, false, true],
			});
		});

		test('does not start its reporting timer when mobile relay is initially disabled', () => {
			const { provider, timer, logs } = createStatePushMetricsProviderFixture();

			provider.setStatePushMetricsEnabled(false);
			timer.fire();

			assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals, logs }, {
				active: false,
				intervals: [],
				logs: [],
			});
		});

		test('starts its reporting timer only once for repeated enabled settings', () => {
			const { provider, timer } = createStatePushMetricsProviderFixture();

			provider.setStatePushMetricsEnabled(true);
			provider.setStatePushMetricsEnabled(true);

			assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals }, {
				active: true,
				intervals: [60_000],
			});
		});

		test('logs accumulated state push activity when its timer fires', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();
			provider.setStatePushMetricsEnabled(true);
			state.pushStateCalls = 3;
			state.pushStateSkipped = 1;
			state.snapshotMetrics.set('attach', { count: 2, maxChars: 80, totalChars: 120 });

			timer.fire();

			assert.deepStrictEqual(logs, ['[paradisMobileRelay][metrics] state push: 3 calls, 1 skipped (no change), 2 forwarded, terminals=0, stateBytes=0 | terminal snapshots: attach=2/max80/total120']);
		});

		test('resets reported counters so an idle next timer callback produces no log', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();
			provider.setStatePushMetricsEnabled(true);
			state.pushStateCalls = 1;
			state.pushStateSkipped = 1;
			state.snapshotMetrics.set('flow', { count: 1, maxChars: 20, totalChars: 20 });

			timer.fire();
			timer.fire();

			assert.deepStrictEqual({ logs: logs.length, pushStateCalls: state.pushStateCalls, pushStateSkipped: state.pushStateSkipped, snapshotMetrics: state.snapshotMetrics.size }, {
				logs: 1,
				pushStateCalls: 0,
				pushStateSkipped: 0,
				snapshotMetrics: 0,
			});
		});

		test('suppresses a reporting callback queued before relay is disabled', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();
			state.pushStateCalls = 4;

			provider.setStatePushMetricsEnabled(true);
			provider.setStatePushMetricsEnabled(false);
			timer.fireQueued(0);

			assert.deepStrictEqual({ active: timer.active, logs, pushStateCalls: state.pushStateCalls }, {
				active: false,
				logs: [],
				pushStateCalls: 0,
			});
		});

		test('ignores a queued callback from before an off-on cycle until the new timer fires', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();

			provider.setStatePushMetricsEnabled(true);
			provider.setStatePushMetricsEnabled(false);
			provider.setStatePushMetricsEnabled(true);
			state.pushStateCalls = 2;
			timer.fireQueued(0);

			assert.deepStrictEqual({ logs, pushStateCalls: state.pushStateCalls }, {
				logs: [],
				pushStateCalls: 2,
			});

			timer.fire();

			assert.deepStrictEqual({ logs, pushStateCalls: state.pushStateCalls }, {
				logs: ['[paradisMobileRelay][metrics] state push: 2 calls, 0 skipped (no change), 2 forwarded, terminals=0, stateBytes=0'],
				pushStateCalls: 0,
			});
		});

		test('starts a fresh timer and fresh metrics after relay is enabled again', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();

			provider.setStatePushMetricsEnabled(true);
			state.pushStateCalls = 5;
			provider.setStatePushMetricsEnabled(false);
			state.pushStateCalls = 2;
			provider.setStatePushMetricsEnabled(true);
			state.pushStateCalls = 2;
			timer.fire();

			assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals, logs }, {
				active: true,
				intervals: [60_000, 60_000],
				logs: ['[paradisMobileRelay][metrics] state push: 2 calls, 0 skipped (no change), 2 forwarded, terminals=0, stateBytes=0'],
			});
		});

		test('discards state push activity recorded while relay is disabled before scheduling enabled metrics', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();
			state.pushStateCalls = 3;
			state.pushStateSkipped = 1;
			state.snapshotMetrics.set('disabled', { count: 1, maxChars: 40, totalChars: 40 });

			provider.setStatePushMetricsEnabled(true);
			timer.fire();

			assert.deepStrictEqual({ logs, pushStateCalls: state.pushStateCalls, pushStateSkipped: state.pushStateSkipped, snapshotMetrics: state.snapshotMetrics.size }, {
				logs: [],
				pushStateCalls: 0,
				pushStateSkipped: 0,
				snapshotMetrics: 0,
			});
		});
	});

	suite('refreshPrStatuses', () => {
		interface IRefreshPrStatusesFixture {
			refreshPrStatuses(): Promise<void>;
		}

		function createFixture(options: {
			repositories: readonly IParadisWorkspaceRepository[];
			worktrees?: ReadonlyMap<string, readonly IParadisWorktree[]>;
			getPrStatuses: (uris: readonly URI[]) => Promise<Record<string, IParadisPrStatus> | undefined>;
			isReachableWorkspaceUri?: (uri: URI) => boolean;
		}) {
			// フルコンストラクタは大量の DI 依存を要求するため、プロトタイプだけを流用して
			// refreshPrStatuses が実際に触るフィールドだけを与える（handleTerminalScroll の
			// テストと同じ手法）。
			const provider = Object.create(ParadisMobileWorkspaceProvider.prototype) as unknown as IRefreshPrStatusesFixture & {
				mobileOnline: boolean;
				prStatusesInFlight: boolean;
				prStatusCache: Map<string, IParadisPrStatus>;
				prStatusScheduler: { schedule(): void };
				workspaceSwitchService: { repositories: readonly IParadisWorkspaceRepository[] };
				worktreeService: { getWorktrees(repositoryId: string): readonly IParadisWorktree[] };
				getPrStatuses: (uris: readonly URI[]) => Promise<Record<string, IParadisPrStatus> | undefined>;
				isReachableWorkspaceUri: (uri: URI) => boolean;
				logService: NullLogService;
				pushStateSoon(): void;
			};
			provider.mobileOnline = true;
			provider.prStatusesInFlight = false;
			provider.prStatusCache = new Map();
			provider.prStatusScheduler = { schedule: () => { } };
			provider.workspaceSwitchService = { repositories: options.repositories };
			provider.worktreeService = { getWorktrees: (id: string) => options.worktrees?.get(id) ?? [] };
			provider.getPrStatuses = options.getPrStatuses;
			provider.isReachableWorkspaceUri = options.isReachableWorkspaceUri ?? (() => true);
			provider.logService = new NullLogService();
			provider.pushStateSoon = () => { };
			return provider;
		}

		test('passes a URI array (not fsPath strings) to getPrStatuses, for reachable repositories/worktrees only', async () => {
			const requests: (readonly URI[])[] = [];
			const localRepo: IParadisWorkspaceRepository = { id: 'local', name: 'Local', uri: URI.file('/repositories/local') };
			const remoteRepo: IParadisWorkspaceRepository = { id: 'remote', name: 'Remote', uri: URI.parse('vscode-remote://ssh-remote+host/repo') };
			const unreachableRepo: IParadisWorkspaceRepository = { id: 'unreachable', name: 'Unreachable', uri: URI.parse('vscode-remote://ssh-remote+other/repo') };
			const fixture = createFixture({
				repositories: [localRepo, remoteRepo, unreachableRepo],
				getPrStatuses: async uris => { requests.push(uris); return undefined; },
				isReachableWorkspaceUri: uri => uri.scheme === 'file' || uri.authority === 'ssh-remote+host',
			});

			await fixture.refreshPrStatuses();

			assert.strictEqual(requests.length, 1);
			assert.ok(requests[0].every(uri => uri instanceof URI), 'every request entry must be a URI instance, not a plain path string');
			assert.deepStrictEqual(requests[0].map(uri => uri.toString()), [localRepo.uri.toString(), remoteRepo.uri.toString()]);
		});

		test('maps the fsPath-keyed result back onto the matching repository/worktree state key', async () => {
			const repo: IParadisWorkspaceRepository = { id: 'one', name: 'One', uri: URI.file('/repositories/one') };
			const worktree: IParadisWorktree = { repositoryId: 'one', name: 'Feature', uri: URI.file('/worktrees/one-feature') };
			const fixture = createFixture({
				repositories: [repo],
				worktrees: new Map([['one', [worktree]]]),
				getPrStatuses: async () => ({
					[repo.uri.fsPath]: { number: 1, title: 'Repo PR', url: 'https://example.com/1', state: 'open' },
					[worktree.uri.fsPath]: { number: 2, title: 'Worktree PR', url: 'https://example.com/2', state: 'draft' },
				}),
			});

			await fixture.refreshPrStatuses();

			assert.deepStrictEqual([...fixture.prStatusCache.entries()].sort(([a], [b]) => a.localeCompare(b)), [
				['one', { number: 1, title: 'Repo PR', url: 'https://example.com/1', state: 'open' }],
				[`worktree:${worktree.uri.toString()}`, { number: 2, title: 'Worktree PR', url: 'https://example.com/2', state: 'draft' }],
			]);
		});
	});
});
