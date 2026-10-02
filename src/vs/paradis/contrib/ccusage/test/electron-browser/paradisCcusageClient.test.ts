/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as sinon from 'sinon';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import {
	IParadisCcusageBlock,
	IParadisCcusageDailyRow,
	IParadisCcusageSessionRow,
	ParadisCcusageProjects,
} from '../../common/paradisCcusage.js';
import { ParadisCcusageClient, paradisCcusageDateArg, paradisCcusageLocalTimeZone, paradisCcusageProjectDisplayName } from '../../electron-browser/paradisCcusageClient.js';

interface IChannelCall {
	readonly channel: string;
	readonly command: string;
	readonly args: unknown;
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 4; index++) {
		await Promise.resolve();
	}
}

function configurationChange(affectedKey: string): IConfigurationChangeEvent {
	return { affectsConfiguration: key => key === affectedKey } as IConfigurationChangeEvent;
}

/** SSH 先へ頼むときは、日付の区切りを手元に合わせるためタイムゾーンを添える。 */
const remoteTimeZone = paradisCcusageLocalTimeZone();
const remoteDailyOptions = { since: '20260519', ...(remoteTimeZone === undefined ? {} : { timezone: remoteTimeZone }) };

suite('ParadisCcusageClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	teardown(() => sinon.restore());

	test('formats a local calendar date as the compact ccusage argument', () => {
		assert.strictEqual(paradisCcusageDateArg(new Date(2026, 0, 5, 23, 59, 59)), '20260105');
		assert.strictEqual(paradisCcusageDateArg(new Date(2026, 10, 29, 0, 0, 1)), '20261129');
	});

	test('reduces encoded home and repository prefixes without damaging plain project names', () => {
		assert.deepStrictEqual([
			paradisCcusageProjectDisplayName('-Users-user-github-para-code'),
			paradisCcusageProjectDisplayName('-home-magu-projects-client-portal'),
			paradisCcusageProjectDisplayName('-Users-user-work-api'),
			paradisCcusageProjectDisplayName('plain-project'),
			paradisCcusageProjectDisplayName('-Users-user-github-'),
		], [
			'para-code',
			'client-portal',
			'api',
			'plain-project',
			'-Users-user-github-',
		]);
	});

	test('creates status and dashboard leases from the authoritative fixed targets', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const configurationChanges = new Emitter<IConfigurationChangeEvent>();
		const calls: IChannelCall[] = [];
		const channel = {
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: 'local', command, args });
				return Promise.resolve([] as T);
			},
		};
		const client = new ParadisCcusageClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{ getValue: () => '  /custom/ccusage  ', onDidChangeConfiguration: configurationChanges.event } as unknown as IConfigurationService,
			{ getConnection: () => null } as unknown as IRemoteAgentService,
		);

		const status = client.createStatusWarmLease();
		await flushMicrotasks();
		const dashboard = client.createDashboardWarmLease();
		await flushMicrotasks();
		const statusPayload = (calls[0]?.args as readonly [{ readonly ownerId: string }])[0];
		const dashboardPayload = (calls[1]?.args as readonly [{ readonly ownerId: string }])[0];

		assert.deepStrictEqual(calls.slice(0, 2), [
			{
				channel: 'local',
				command: 'setWarmLease',
				args: [{
					ownerId: statusPayload.ownerId,
					active: true,
					targets: [{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } }],
				}],
			},
			{
				channel: 'local',
				command: 'setWarmLease',
				args: [{
					ownerId: dashboardPayload.ownerId,
					active: true,
					targets: [
						{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } },
						{ kind: 'blocks', options: { executablePath: '/custom/ccusage' } },
						{ kind: 'session', options: { executablePath: '/custom/ccusage', since: '20260519' } },
						{ kind: 'projects', options: { executablePath: '/custom/ccusage', since: '20260519' } },
					],
				}],
			},
		]);

		await clock.tickAsync(5 * 60 * 1000);
		status.dispose();
		dashboard.dispose();
		await flushMicrotasks();
		configurationChanges.dispose();

		assert.deepStrictEqual(calls.slice(2).map(call => ({ command: call.command, args: call.args })), [
			{ command: 'setWarmLease', args: [{ ownerId: statusPayload.ownerId, active: true, targets: [{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } }] }] },
			{
				command: 'setWarmLease', args: [{
					ownerId: dashboardPayload.ownerId, active: true, targets: [
						{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } },
						{ kind: 'blocks', options: { executablePath: '/custom/ccusage' } },
						{ kind: 'session', options: { executablePath: '/custom/ccusage', since: '20260519' } },
						{ kind: 'projects', options: { executablePath: '/custom/ccusage', since: '20260519' } },
					]
				}]
			},
			{ command: 'setWarmLease', args: [{ ownerId: statusPayload.ownerId, active: false, targets: [] }] },
			{ command: 'setWarmLease', args: [{ ownerId: dashboardPayload.ownerId, active: false, targets: [] }] },
		]);
	});

	test('updates warm targets only when the configuration event requests a renewal', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const configurationChanges = new Emitter<IConfigurationChangeEvent>();
		const calls: IChannelCall[] = [];
		const channel = {
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: 'local', command, args });
				return Promise.resolve([] as T);
			},
		};
		const client = new ParadisCcusageClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{ getValue: () => '/custom/ccusage', onDidChangeConfiguration: configurationChanges.event } as unknown as IConfigurationService,
			{ getConnection: () => null } as unknown as IRemoteAgentService,
		);

		const lease = client.createStatusWarmLease();
		await flushMicrotasks();
		clock.setSystemTime(new Date(2026, 7, 17, 12, 0, 0));
		await flushMicrotasks();
		configurationChanges.fire(configurationChange('editor.fontSize'));
		await flushMicrotasks();
		configurationChanges.fire(configurationChange('paradis.ccusage.executablePath'));
		await flushMicrotasks();
		const ownerId = ((calls[0]?.args as readonly [{ readonly ownerId: string }])[0]).ownerId;
		lease.dispose();
		await flushMicrotasks();
		configurationChanges.dispose();

		assert.deepStrictEqual(calls.map(call => call.args), [
			[{ ownerId, active: true, targets: [{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } }] }],
			[{ ownerId, active: true, targets: [{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260520' } }] }],
			[{ ownerId, active: false, targets: [] }],
		]);
	});

	test('keeps a captured channel for the same remote connection and transfers ownership across routes', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const configurationChanges = new Emitter<IConfigurationChangeEvent>();
		const calls: IChannelCall[] = [];
		const createChannel = (name: string) => ({
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: name, command, args });
				return Promise.resolve([] as T);
			},
		});
		const remoteA = createChannel('remote-a');
		const remoteB = createChannel('remote-b');
		const remoteC = createChannel('remote-c');
		const local = createChannel('local');
		let currentRemoteChannel = remoteA;
		const firstConnection = { getChannel: () => currentRemoteChannel };
		const secondConnection = { getChannel: () => remoteC };
		let connection: typeof firstConnection | typeof secondConnection | null = firstConnection;
		const client = new ParadisCcusageClient(
			{ getChannel: () => local } as unknown as ISharedProcessService,
			{ getValue: () => '', onDidChangeConfiguration: configurationChanges.event } as unknown as IConfigurationService,
			{ getConnection: () => connection } as unknown as IRemoteAgentService,
		);

		const lease = client.createStatusWarmLease();
		await flushMicrotasks();
		currentRemoteChannel = remoteB;
		await clock.tickAsync(5 * 60 * 1000);
		connection = secondConnection;
		await clock.tickAsync(5 * 60 * 1000);
		connection = null;
		await clock.tickAsync(5 * 60 * 1000);
		const ownerId = ((calls[0]?.args as readonly [{ readonly ownerId: string }])[0]).ownerId;
		lease.dispose();
		await flushMicrotasks();
		configurationChanges.dispose();

		assert.deepStrictEqual(calls.map(call => ({ channel: call.channel, args: call.args })), [
			{ channel: 'remote-a', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: remoteDailyOptions }] }] },
			{ channel: 'remote-a', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: remoteDailyOptions }] }] },
			{ channel: 'remote-a', args: [{ ownerId, active: false, targets: [] }] },
			{ channel: 'remote-c', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: remoteDailyOptions }] }] },
			{ channel: 'remote-c', args: [{ ownerId, active: false, targets: [] }] },
			{ channel: 'local', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: { since: '20260519' } }] }] },
			{ channel: 'local', args: [{ ownerId, active: false, targets: [] }] },
		]);
	});

	test('releases the captured attempted route when an ambiguous acquire rejects before retirement', async () => {
		sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const configurationChanges = new Emitter<IConfigurationChangeEvent>();
		const calls: IChannelCall[] = [];
		const remoteA = {
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: 'remote-a', command, args });
				const payload = (args as readonly [{ readonly active: boolean }])[0];
				return payload.active ? Promise.reject(new Error('response lost')) : Promise.resolve(undefined as T);
			},
		};
		const remoteB = {
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: 'remote-b', command, args });
				return Promise.resolve(undefined as T);
			},
		};
		const firstConnection = { getChannel: () => remoteA };
		const secondConnection = { getChannel: () => remoteB };
		let connection: typeof firstConnection | typeof secondConnection = firstConnection;
		const client = new ParadisCcusageClient(
			{ getChannel: () => remoteB } as unknown as ISharedProcessService,
			{ getValue: () => '', onDidChangeConfiguration: configurationChanges.event } as unknown as IConfigurationService,
			{ getConnection: () => connection } as unknown as IRemoteAgentService,
		);

		const lease = client.createStatusWarmLease();
		await flushMicrotasks();
		const ownerId = ((calls[0]?.args as readonly [{ readonly ownerId: string }])[0]).ownerId;
		connection = secondConnection;
		lease.dispose();
		await flushMicrotasks();
		configurationChanges.dispose();

		assert.deepStrictEqual(calls.map(call => ({ channel: call.channel, args: call.args })), [
			{ channel: 'remote-a', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: remoteDailyOptions }] }] },
			{ channel: 'remote-a', args: [{ ownerId, active: false, targets: [] }] },
		]);
	});

	test('keeps the captured local channel when the shared process returns a new wrapper', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const configurationChanges = new Emitter<IConfigurationChangeEvent>();
		const calls: IChannelCall[] = [];
		const createChannel = (name: string) => ({
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: name, command, args });
				return Promise.resolve([] as T);
			},
		});
		const localA = createChannel('local-a');
		const localB = createChannel('local-b');
		let currentChannel = localA;
		const client = new ParadisCcusageClient(
			{ getChannel: () => currentChannel } as unknown as ISharedProcessService,
			{ getValue: () => '', onDidChangeConfiguration: configurationChanges.event } as unknown as IConfigurationService,
			{ getConnection: () => null } as unknown as IRemoteAgentService,
		);

		const lease = client.createStatusWarmLease();
		await flushMicrotasks();
		currentChannel = localB;
		await clock.tickAsync(5 * 60 * 1000);
		const ownerId = ((calls[0]?.args as readonly [{ readonly ownerId: string }])[0]).ownerId;
		lease.dispose();
		await flushMicrotasks();
		configurationChanges.dispose();

		assert.deepStrictEqual(calls.map(call => ({ channel: call.channel, args: call.args })), [
			{ channel: 'local-a', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: { since: '20260519' } }] }] },
			{ channel: 'local-a', args: [{ ownerId, active: true, targets: [{ kind: 'daily', options: { since: '20260519' } }] }] },
			{ channel: 'local-a', args: [{ ownerId, active: false, targets: [] }] },
		]);
	});

	test('sends the dashboard target set for one-shot mobile ownership', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const calls: IChannelCall[] = [];
		const channel = {
			call<T>(command: string, args?: unknown): Promise<T> {
				calls.push({ channel: 'local', command, args });
				return Promise.resolve([] as T);
			},
		};
		const client = new ParadisCcusageClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{ getValue: () => ' /custom/ccusage ' } as unknown as IConfigurationService,
			{ getConnection: () => null } as unknown as IRemoteAgentService,
		);

		await client.setDashboardWarmLease('mobile-owner', true);
		await client.setDashboardWarmLease('mobile-owner', false);

		assert.deepStrictEqual(calls.map(call => call.args), [
			[{
				ownerId: 'mobile-owner', active: true, targets: [
					{ kind: 'daily', options: { executablePath: '/custom/ccusage', since: '20260519' } },
					{ kind: 'blocks', options: { executablePath: '/custom/ccusage' } },
					{ kind: 'session', options: { executablePath: '/custom/ccusage', since: '20260519' } },
					{ kind: 'projects', options: { executablePath: '/custom/ccusage', since: '20260519' } },
				]
			}],
			[{ ownerId: 'mobile-owner', active: false, targets: [] }],
		]);
		clock.restore();
	});

	test('normalizes dashboard payloads through the public client contract', async () => {
		const dailyFixture = [
			{
				period: '2026-07-29',
				modelBreakdowns: [{
					modelName: 'gpt-5',
					inputTokens: 120,
					outputTokens: 30,
					cacheCreationTokens: 10,
					cacheReadTokens: 40,
					cost: 1.25,
				}],
			},
			{
				period: '2026-07-28',
				modelBreakdowns: [{
					modelName: 'claude-sonnet-4',
				}],
			},
		] satisfies IParadisCcusageDailyRow[];
		const blockFixture = {
			id: 'active',
			isActive: true,
			isGap: false,
			startTime: '2026-07-29T00:00:00.000Z',
			endTime: '2026-07-29T05:00:00.000Z',
			actualEndTime: '2026-07-29T01:00:00.000Z',
			costUSD: 2.5,
			totalTokens: 200,
			models: ['gpt-5'],
			tokenCounts: {
				inputTokens: 120,
				outputTokens: 30,
				cacheCreationInputTokens: 10,
				cacheReadInputTokens: 40,
			},
			burnRate: { costPerHour: 0.5, tokensPerMinute: 20 },
			projection: { remainingMinutes: 240, totalCost: 4.5, totalTokens: 500 },
		} satisfies IParadisCcusageBlock;
		const sessionsFixture = [
			{
				sessionId: 'session-older',
				projectPath: '-Users-user-github-older',
				firstActivity: 'invalid',
				lastActivity: 'invalid',
				inputTokens: 5,
				outputTokens: 4,
				cacheCreationTokens: 3,
				cacheReadTokens: 2,
				totalTokens: 14,
				modelBreakdowns: [{ modelName: 'claude-sonnet-4', cost: 0.75 }],
				modelsUsed: ['claude-sonnet-4'],
			},
			{
				sessionId: 'session-newer',
				projectPath: '-Users-user-github-newer',
				firstActivity: '2026-07-29T00:00:00.000Z',
				lastActivity: '2026-07-29T02:00:00.000Z',
				inputTokens: 10,
				outputTokens: 8,
				cacheCreationTokens: 6,
				cacheReadTokens: 4,
				totalCost: 1.5,
				totalTokens: 28,
				modelBreakdowns: [{ modelName: 'gpt-5', cost: 1.5 }],
				modelsUsed: ['gpt-5'],
			},
		] satisfies IParadisCcusageSessionRow[];
		const projectsFixture = {
			'-Users-user-github-para-code': [
				{ date: '2026-07-28', totalCost: 0.5, totalTokens: 10, inputTokens: 6, outputTokens: 4 },
				{ date: '2026-07-29', totalTokens: 20, inputTokens: 12, outputTokens: 8 },
			],
		} satisfies ParadisCcusageProjects;
		const channel = {
			call: async <T>(command: string): Promise<T> => {
				let result: unknown;
				switch (command) {
					case 'fetchDaily':
						result = dailyFixture;
						break;
					case 'fetchActiveBlock':
						result = blockFixture;
						break;
					case 'fetchRecentSessions':
						result = sessionsFixture;
						break;
					case 'fetchProjects':
						result = projectsFixture;
						break;
					default:
						// fetchReport を持たない古い接続先として振る舞わせる（従来のコマンドへ落ちる）
						throw new Error(`Method not found: ${command}`);
				}
				return result as T;
			},
		};
		const client = new ParadisCcusageClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{ getValue: () => '' } as unknown as IConfigurationService,
			// 繋いでいないウィンドウとして振る舞わせる（接続中は接続先のチャネルへ聞く）
			{ getConnection: () => null } as unknown as IRemoteAgentService,
		);

		const dashboard = await client.fetchDashboard();

		assert.deepStrictEqual(dashboard.days, [
			{
				date: '2026-07-28',
				models: [{
					model: 'claude-sonnet-4',
					agent: 'claude',
					cost: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
				}],
			},
			{
				date: '2026-07-29',
				models: [{
					model: 'gpt-5',
					agent: 'codex',
					cost: 1.25,
					inputTokens: 120,
					outputTokens: 30,
					cacheCreationTokens: 10,
					cacheReadTokens: 40,
				}],
			},
		]);
		assert.deepStrictEqual(dashboard.block, {
			startTime: 1_785_283_200_000,
			endTime: 1_785_301_200_000,
			costUSD: 2.5,
			remainingMinutes: 240,
			projectedCost: 4.5,
			projectedTokens: 500,
			costPerHour: 0.5,
			tokensPerMinute: 20,
		});
		assert.deepStrictEqual(dashboard.sessions, [
			{
				project: 'newer',
				rawProject: '-Users-user-github-newer',
				lastActivity: 1_785_290_400_000,
				models: ['gpt-5'],
				totalTokens: 28,
				totalCost: 1.5,
			},
			{
				project: 'older',
				rawProject: '-Users-user-github-older',
				lastActivity: undefined,
				models: ['claude-sonnet-4'],
				totalTokens: 14,
				totalCost: 0.75,
			},
		]);
		assert.deepStrictEqual(dashboard.projects, [{
			name: 'para-code',
			rawName: '-Users-user-github-para-code',
			dailyCosts: [
				{ date: '2026-07-28', cost: 0.5 },
				{ date: '2026-07-29', cost: 0 },
			],
		}]);
		assert.deepStrictEqual(dashboard.failedReports, []);
		assert.ok(Number.isFinite(dashboard.fetchedAt));
	});

	// 取得時刻と古さは fetchReport から受け取り、ダッシュボードには最も古い取得時刻と「古い値を含む」を載せる。
	// 昨日以前に取った古い値には今日の行が無いので、ステータスバーには $0.00 でなく「分からない」を返す。
	test('carries the oldest fetch time and staleness from fetchReport and hides a stale today cost from a previous day', async () => {
		const clock = sinon.useFakeTimers({ now: new Date(2026, 7, 16, 12, 0, 0) });
		const yesterday = new Date(2026, 7, 15, 23, 0, 0).getTime();
		const earlierToday = new Date(2026, 7, 16, 9, 0, 0).getTime();
		let dailyFetchedAt = yesterday;
		const commands: string[] = [];
		const channel = {
			call: async <T>(command: string, args?: unknown): Promise<T> => {
				commands.push(command);
				const kind = (args as readonly [{ readonly kind: string }])[0].kind;
				const values: Record<string, unknown> = {
					daily: [{ period: '2026-08-15', totalCost: 3 }],
					blocks: undefined,
					session: [],
					projects: {},
				};
				const fetchedAt = kind === 'daily' ? dailyFetchedAt : earlierToday;
				return { value: values[kind], fetchedAt, stale: kind === 'daily' } as T;
			},
		};
		const client = new ParadisCcusageClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{ getValue: () => '' } as unknown as IConfigurationService,
			{ getConnection: () => null } as unknown as IRemoteAgentService,
		);

		const dashboard = await client.fetchDashboard();
		const staleFromYesterday = await client.fetchTodayCost();
		dailyFetchedAt = earlierToday;
		const staleFromToday = await client.fetchTodayCost();
		clock.restore();

		assert.deepStrictEqual({
			fetchedAt: dashboard.fetchedAt,
			stale: dashboard.stale,
			staleFromYesterday,
			staleFromToday,
			commands: [...new Set(commands)],
		}, {
			fetchedAt: yesterday,
			stale: true,
			staleFromYesterday: undefined,
			staleFromToday: 0,
			commands: ['fetchReport'],
		});
	});
});
