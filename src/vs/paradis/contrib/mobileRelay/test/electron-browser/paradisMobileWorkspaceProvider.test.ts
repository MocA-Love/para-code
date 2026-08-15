/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

import * as assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileWorkspaceProvider, paradisResolveLocalAgentPaneCwd, paradisScreenShowsMarker } from '../../electron-browser/paradisMobileWorkspaceProvider.js';

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
		...initialState,
		lastPushedSnapshot: undefined,
		allInstances: () => [],
		logService: { info: (message: string) => logs.push(message) },
	}) as IStatePushMetricsProviderFixture;
	const state = provider as IStatePushMetricsProviderFixture & typeof initialState;
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

	suite('state push metrics', () => {
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
			state.pushStateCalls = 3;
			state.pushStateSkipped = 1;
			state.snapshotMetrics.set('attach', { count: 2, maxChars: 80, totalChars: 120 });

			provider.setStatePushMetricsEnabled(true);
			timer.fire();

			assert.deepStrictEqual(logs, ['[paradisMobileRelay][metrics] state push: 3 calls, 1 skipped (no change), 2 forwarded, terminals=0, stateBytes=0 | terminal snapshots: attach=2/max80/total120']);
		});

		test('resets reported counters so an idle next timer callback produces no log', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();
			state.pushStateCalls = 1;
			state.pushStateSkipped = 1;
			state.snapshotMetrics.set('flow', { count: 1, maxChars: 20, totalChars: 20 });

			provider.setStatePushMetricsEnabled(true);
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

		test('starts a fresh timer and fresh metrics after relay is enabled again', () => {
			const { provider, timer, logs, state } = createStatePushMetricsProviderFixture();
			state.pushStateCalls = 5;

			provider.setStatePushMetricsEnabled(true);
			provider.setStatePushMetricsEnabled(false);
			state.pushStateCalls = 2;
			provider.setStatePushMetricsEnabled(true);
			timer.fire();

			assert.deepStrictEqual({ active: timer.active, intervals: timer.intervals, logs }, {
				active: true,
				intervals: [60_000, 60_000],
				logs: ['[paradisMobileRelay][metrics] state push: 2 calls, 0 skipped (no change), 2 forwarded, terminals=0, stateBytes=0'],
			});
		});
	});
});
