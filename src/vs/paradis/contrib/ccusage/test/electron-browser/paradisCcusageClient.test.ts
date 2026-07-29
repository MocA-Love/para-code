/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import {
	IParadisCcusageBlock,
	IParadisCcusageDailyRow,
	IParadisCcusageSessionRow,
	ParadisCcusageProjects,
} from '../../common/paradisCcusage.js';
import { ParadisCcusageClient, paradisCcusageDateArg, paradisCcusageProjectDisplayName } from '../../electron-browser/paradisCcusageClient.js';

suite('ParadisCcusageClient', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats a local calendar date as the compact ccusage argument', () => {
		assert.strictEqual(paradisCcusageDateArg(new Date(2026, 0, 5, 23, 59, 59)), '20260105');
		assert.strictEqual(paradisCcusageDateArg(new Date(2026, 10, 29, 0, 0, 1)), '20261129');
	});

	test('reduces encoded home and repository prefixes without damaging plain project names', () => {
		assert.deepStrictEqual([
			paradisCcusageProjectDisplayName('-Users-magu-github-para-code'),
			paradisCcusageProjectDisplayName('-home-magu-projects-client-portal'),
			paradisCcusageProjectDisplayName('-Users-magu-work-api'),
			paradisCcusageProjectDisplayName('plain-project'),
			paradisCcusageProjectDisplayName('-Users-magu-github-'),
		], [
			'para-code',
			'client-portal',
			'api',
			'plain-project',
			'-Users-magu-github-',
		]);
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
				projectPath: '-Users-magu-github-older',
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
				projectPath: '-Users-magu-github-newer',
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
			'-Users-magu-github-para-code': [
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
						throw new Error(`unexpected command: ${command}`);
				}
				return result as T;
			},
		};
		const client = new ParadisCcusageClient(
			{ getChannel: () => channel } as unknown as ISharedProcessService,
			{ getValue: () => '' } as unknown as IConfigurationService,
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
				rawProject: '-Users-magu-github-newer',
				lastActivity: 1_785_290_400_000,
				models: ['gpt-5'],
				totalTokens: 28,
				totalCost: 1.5,
			},
			{
				project: 'older',
				rawProject: '-Users-magu-github-older',
				lastActivity: undefined,
				models: ['claude-sonnet-4'],
				totalTokens: 14,
				totalCost: 0.75,
			},
		]);
		assert.deepStrictEqual(dashboard.projects, [{
			name: 'para-code',
			rawName: '-Users-magu-github-para-code',
			dailyCosts: [
				{ date: '2026-07-28', cost: 0.5 },
				{ date: '2026-07-29', cost: 0 },
			],
		}]);
		assert.deepStrictEqual(dashboard.failedReports, []);
		assert.ok(Number.isFinite(dashboard.fetchedAt));
	});
});
