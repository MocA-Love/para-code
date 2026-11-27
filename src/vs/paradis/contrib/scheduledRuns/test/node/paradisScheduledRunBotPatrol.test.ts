/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisScheduledRunDefinition, IParadisScheduledRunRequest } from '../../common/paradisScheduledRuns.js';
import { IParadisBotPatrolInput, ParadisBotPatrolGateState, PARADIS_BOT_PATROL_DEFAULT_SCHEDULE } from '../../common/paradisScheduledRunBotPatrol.js';
import { paradisParseScheduledRunsState, paradisScheduledRunDefinitionDigest } from '../../node/paradisScheduledRunsChannel.js';
import { IParadisScheduledRunsStoredState, ParadisScheduledRunsService } from '../../node/paradisScheduledRunsService.js';

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

const PATROL: IParadisBotPatrolInput = { schedule: PARADIS_BOT_PATROL_DEFAULT_SCHEDULE, lookFor: '止まっている PR', enabled: true };

suite('ParadisScheduledRunsService: bot look-arounds', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	// 2026-11-27 は金曜日
	function setup(startAt = at(2026, 11, 27, 9, 0), initial?: IParadisScheduledRunsStoredState) {
		const state = { now: startAt, stored: initial };
		const gate = { state: 'ok' as ParadisBotPatrolGateState | undefined, closed: [] as string[], bots: new Map([['b1', 'リリース係']]) };
		const service = disposables.add(new ParadisScheduledRunsService({
			read: async () => state.stored,
			write: async value => { state.stored = value; },
		}, { now: () => state.now }, new NullLogService(), { startTimer: false, hookEvents: disposables.add(new Emitter<never>()).event }));
		disposables.add(service.setBotPatrolGate({
			check: botId => gate.bots.has(botId) ? gate.state : (gate.state === undefined ? undefined : 'missing'),
			botName: botId => gate.bots.get(botId),
			closeIdlePatrolPanes: botId => gate.closed.push(botId),
		}));
		const requests: IParadisScheduledRunRequest[] = [];
		disposables.add(service.onDidRequestRun(request => requests.push(request)));
		const statuses = () => service.flush().then(() => state.stored?.runs.map(run => [run.status, run.reason ?? '', run.trigger]) ?? []);
		return { state, gate, service, requests, statuses };
	}

	test('作る・読む: 1 つの Bot に 1 つ。定期実行の画面には出さず、汎用の保存では変えられない', async () => {
		const { service } = setup();
		await service.whenReady();
		const created = await service.setBotPatrol('b1', PATROL);
		const again = await service.setBotPatrol('b1', { ...PATROL, lookFor: '失敗した CI' });
		const definition = again.definition!;
		const { id: _id, createdAt: _c, updatedAt: _u, enabled: _e, ...draft } = definition;
		assert.deepStrictEqual({
			sameId: created.definition?.id === definition.id,
			definition: { name: definition.name, schedule: definition.schedule, target: definition.target, agentId: definition.agentId, prompt: definition.prompt, dailyLimit: definition.dailyLimit, enabled: definition.enabled },
			listed: service.getState().definitions.length,
			view: await service.getBotPatrol('b1'),
			unknownBot: (await service.setBotPatrol('nobody', PATROL)).ok,
			badInput: [(await service.setBotPatrol('b1', { ...PATROL, schedule: { everyHours: 5, fromHour: 8, toHour: 20, weekdaysOnly: true } })).ok, (await service.setBotPatrol('b1', 'x')).ok],
			// 見回りの間隔の下限（60 分）より短い式は断る
			tooShort: await service.setBotPatrol('b1', { ...PATROL, schedule: '*/30 * * * *' }),
			// 間隔が分の幅を超える式（*/90 は毎時 0 分になる）は断る
			tooLargeStep: (await service.setBotPatrol('b1', { ...PATROL, schedule: '*/90 * * * *' })).ok,
			// 汎用の保存（定期実行の画面・エージェントの道具）は Bot の見回りを作れず、変えられない
			genericCreate: (await service.save({ ...draft })).ok,
			genericOverwrite: (await service.save({ ...draft, id: definition.id, target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' }, agentId: 'claude', prompt: 'x' })).ok,
		}, {
			sameId: true,
			definition: {
				name: 'リリース係 の見回り', schedule: '0 8-20/4 * * 1-5',
				target: { kind: 'bot', repositoryUri: '', repositoryName: 'リリース係', botId: 'b1' },
				agentId: '', prompt: '失敗した CI', dailyLimit: 24, enabled: true,
			},
			listed: 0,
			view: {
				definitionId: definition.id, enabled: true,
				schedule: { everyHours: 4, fromHour: 8, toHour: 20, weekdaysOnly: true },
				cron: '0 8-20/4 * * 1-5', lookFor: '失敗した CI', nextRunAt: at(2026, 11, 27, 12, 0), gate: 'ok', otherPatrolsRunsPerDay: 0,
			},
			unknownBot: false,
			badInput: [false, false],
			tooShort: { ok: false, error: '見回りの間隔は 60 分以上あけてください。' },
			tooLargeStep: false,
			genericCreate: false,
			genericOverwrite: false,
		});
	});

	test('分まで決めた時刻（cron 式）で保存し、その分に開始待ちを作る。前の形で保存した式は同じ形で送り直しても変わらない', async () => {
		const { service, requests, gate } = setup(at(2026, 11, 27, 9, 0));
		gate.bots.set('b2', '見張り');
		await service.whenReady();
		await service.setBotPatrol('b2', { ...PATROL, schedule: '0 * * * *' });
		const legacy = (await service.setBotPatrol('b1', PATROL)).definition!;
		const resent = (await service.setBotPatrol('b1', { ...PATROL, schedule: '0 8-20/4 * * 1-5' })).definition!;
		const minutes = (await service.setBotPatrol('b1', { ...PATROL, schedule: '30 9 * * 1-5' })).definition!;
		const view = await service.getBotPatrol('b1');
		assert.deepStrictEqual({
			legacy: legacy.schedule,
			resentSame: resent.schedule === legacy.schedule,
			minutes: minutes.schedule,
			view: [view.cron, view.schedule, view.nextRunAt, view.otherPatrolsRunsPerDay],
			requests: requests.length,
		}, {
			legacy: '0 8-20/4 * * 1-5',
			resentSame: true,
			minutes: '30 9 * * 1-5',
			view: ['30 9 * * 1-5', undefined, at(2026, 11, 27, 9, 30), 24],
			requests: 0,
		});
	});

	test('時刻どおりに開始待ちを作り、窓が受け持つ前に前の回のペインを閉じてもらう。朝に手動で見回っても 20 時の回は落ちない', async () => {
		const { state, gate, service, requests, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		await service.setBotPatrol('b1', PATROL);
		const manual = await service.runBotPatrolNow('b1');
		await service.claim('window:1', manual.run!.id);
		await service.report('window:1', { runId: manual.run!.id, status: 'completed' });
		const claims: boolean[] = [];
		for (const hour of [8, 12, 16, 20]) {
			state.now = at(2026, 11, 27, hour, 0) + 20_000;
			service.tick();
			const request = requests.at(-1)!;
			claims.push((await service.claim('window:1', request.run.id)) !== undefined);
			await service.report('window:1', { runId: request.run.id, status: 'completed' });
		}
		assert.deepStrictEqual({ claims, closed: gate.closed, runs: await statuses() }, {
			claims: [true, true, true, true],
			closed: ['b1', 'b1', 'b1', 'b1', 'b1'],
			runs: [['completed', '', 'manual'], ['completed', '', 'schedule'], ['completed', '', 'schedule'], ['completed', '', 'schedule'], ['completed', '', 'schedule']],
		});
	});

	test('設定がオフの間は何も記録せず、作る・有効にするも断る。オンにしても逃した回を走らせない。一時停止・前の見回りが動いている間は見送る', async () => {
		const { state, gate, service, requests, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		gate.state = 'off';
		const createWhileOff = await service.setBotPatrol('b1', PATROL);
		gate.state = 'ok';
		const created = await service.setBotPatrol('b1', { ...PATROL, enabled: false });
		gate.state = 'off';
		const enableWhileOff = await service.setEnabled(created.definition!.id, true);
		gate.state = 'ok';
		await service.setEnabled(created.definition!.id, true);
		gate.state = 'off';
		state.now = at(2026, 11, 27, 8, 0) + 20_000;
		service.tick();
		const whileOff = { requests: requests.length, runs: (await statuses()).length };
		gate.state = 'ok';
		state.now = at(2026, 11, 27, 8, 10);
		service.tick();
		const afterOn = { requests: requests.length, runs: (await statuses()).length };
		gate.state = 'paused';
		state.now = at(2026, 11, 27, 12, 0) + 20_000;
		service.tick();
		gate.state = 'busy';
		state.now = at(2026, 11, 27, 16, 0) + 20_000;
		service.tick();
		assert.deepStrictEqual({ refused: [createWhileOff, enableWhileOff], whileOff, afterOn, runs: await statuses(), requests: requests.length }, {
			refused: [{ ok: false, error: 'Bot の機能がオフの間は、見回りを設定・有効にできません。' }, { ok: false, error: 'Bot の機能がオフの間は、見回りを設定・有効にできません。' }],
			whileOff: { requests: 0, runs: 0 },
			afterOn: { requests: 0, runs: 0 },
			runs: [['skipped', 'botPaused', 'schedule'], ['skipped', 'botBusy', 'schedule']],
			requests: 0,
		});
	});

	test('スリープ明けは後から走らせず「逃した」と記録する。台帳を読む前は判定を見送る', async () => {
		const { state, gate, service, requests, statuses } = setup(at(2026, 11, 27, 11, 0));
		await service.whenReady();
		await service.setBotPatrol('b1', PATROL);
		gate.state = undefined;
		state.now = at(2026, 11, 27, 12, 0) + 20_000;
		service.tick();
		const beforeLoad = (await statuses()).length;
		// 金曜 12・16・20 時を寝過ごし、土曜 7 時に起きた
		gate.state = 'ok';
		state.now = at(2026, 11, 28, 7, 0);
		service.tick();
		const stored = state.stored!.runs[0];
		assert.deepStrictEqual({ beforeLoad, runs: await statuses(), skippedCount: stored.skippedCount, scheduledFor: stored.scheduledFor, requests: requests.length }, {
			beforeLoad: 0,
			runs: [['skipped', 'botMissed', 'catchUp']],
			skippedCount: 3,
			scheduledFor: at(2026, 11, 27, 20, 0),
			requests: 0,
		});
	});

	test('開始待ちは 10 分で見送り、受け持つ前に一時停止したら起動しない。手動の見回りも門を通す', async () => {
		const { state, gate, service, requests, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		await service.setBotPatrol('b1', PATROL);
		state.now = at(2026, 11, 27, 8, 0) + 20_000;
		service.tick();
		state.now = at(2026, 11, 27, 8, 11);
		service.tick();
		const manual = await service.runBotPatrolNow('b1');
		gate.state = 'paused';
		const claimed = await service.claim('window:1', manual.run!.id);
		const refused = await service.runBotPatrolNow('b1');
		assert.deepStrictEqual({ claimed, refused, requests: requests.length, runs: await statuses() }, {
			claimed: undefined,
			refused: { ok: false, error: 'Bot を一時停止しているため見回りませんでした' },
			// 時刻の回と手動の回の 2 つ
			requests: 2,
			runs: [['skipped', 'botNoWindow', 'schedule'], ['skipped', 'botPaused', 'manual']],
		});
	});

	test('同じ時刻に 4 つの Bot が重なると、4 つ目は同時実行の上限で見送ったと記録する（ウィンドウが無かったとは記録しない）', async () => {
		const { state, gate, service, requests, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		for (const botId of ['b1', 'b2', 'b3', 'b4']) {
			gate.bots.set(botId, botId);
			await service.setBotPatrol(botId, PATROL);
		}
		state.now = at(2026, 11, 27, 8, 0) + 20_000;
		service.tick();
		const claims: boolean[] = [];
		for (const request of requests) {
			claims.push((await service.claim('window:1', request.run.id)) !== undefined);
		}
		state.now = at(2026, 11, 27, 8, 11);
		service.tick();
		assert.deepStrictEqual({ claims, runs: (await statuses()).map(([status, reason]) => `${status}:${reason}`) }, {
			claims: [true, true, true, false],
			runs: ['starting:', 'starting:', 'starting:', 'skipped:botConcurrency'],
		});
	});

	test('見回りの枠と利用者の枠は受け持ちでも別。今すぐ見回るは枠の理由で断り、枠が空いた後に流れた回はウィンドウが無かったと記録する', async () => {
		const { state, gate, service, requests, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		for (const botId of ['b1', 'b2', 'b3', 'b4']) {
			gate.bots.set(botId, botId);
			await service.setBotPatrol(botId, PATROL);
		}
		state.now = at(2026, 11, 27, 8, 0) + 20_000;
		service.tick();
		const patrols = [...requests];
		const claims: boolean[] = [];
		for (const request of patrols) {
			claims.push((await service.claim('window:1', request.run.id)) !== undefined);
		}
		// 見回りが 3 つ動いていても、利用者の定期実行は受け持てる
		const user = await service.save({ name: '依存の更新確認', schedule: '0 9 * * *', target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' }, agentId: 'claude', prompt: '確認して', dailyLimit: 3 });
		const userRun = await service.runNow(user.definition!.id);
		const userClaimed = (await service.claim('window:1', userRun.run!.id)) !== undefined;
		// 見回りの枠が埋まっているあいだの「今すぐ見回る」は、前の回ではなく枠の理由で断る
		gate.bots.set('b5', 'b5');
		await service.setBotPatrol('b5', PATROL);
		const patrolNow = await service.runBotPatrolNow('b5');
		// 1 つ終わって枠が空いた後、4 つ目を誰も受け持たないまま期限が来たら、ウィンドウが無かったと記録する
		await service.report('window:1', { runId: patrols[0].run.id, status: 'completed' });
		state.now = at(2026, 11, 27, 8, 11);
		service.tick();
		const runs = (await statuses()).map(([status, reason, trigger]) => `${status}:${reason}:${trigger}`);
		assert.deepStrictEqual({ claims, userClaimed, patrolNow, runs }, {
			claims: [true, true, true, false],
			userClaimed: true,
			patrolNow: { ok: false, error: 'ほかの Bot の見回りが 3 つ動いていたため見回りませんでした' },
			runs: ['completed::schedule', 'starting::schedule', 'starting::schedule', 'skipped:botNoWindow:schedule', 'starting::manual'],
		});
	});

	test('開始待ちの間に Bot の機能をオフにすると、受け持つウィンドウを待たずに設定オフで見送る', async () => {
		const { state, gate, service, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		await service.setBotPatrol('b1', PATROL);
		state.now = at(2026, 11, 27, 8, 0) + 20_000;
		service.tick();
		gate.state = 'off';
		state.now += 30_000;
		service.tick();
		assert.deepStrictEqual(await statuses(), [['skipped', 'botsOff', 'schedule']]);
	});

	test('動いている間に Bot の機能をオフにすると、見回りを止めて「オフになったため止めた」と記録する', async () => {
		const { state, gate, service, statuses } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		await service.setBotPatrol('b1', PATROL);
		const manual = await service.runBotPatrolNow('b1');
		await service.claim('window:1', manual.run!.id);
		await service.report('window:1', { runId: manual.run!.id, status: 'running' });
		const stops: string[] = [];
		disposables.add(service.onDidRequestStop(request => stops.push(`${request.runId === manual.run!.id}:${request.claimedBy}`)));
		gate.state = 'off';
		state.now += 60_000;
		service.tick();
		// 受け持ちのウィンドウが止めた後に送ってくる報告は、記録を変えない
		const late = await service.report('window:1', { runId: manual.run!.id, status: 'cancelled', reason: 'userStopped' });
		assert.deepStrictEqual({ stops, late, runs: await statuses() }, {
			stops: ['true:window:1'],
			late: false,
			runs: [['cancelled', 'botsTurnedOff', 'manual']],
		});
	});

	test('Bot を消したら定義と記録も消し、動いている回は止める', async () => {
		const { state, service } = setup(at(2026, 11, 27, 7, 0));
		await service.whenReady();
		await service.setBotPatrol('b1', PATROL);
		const manual = await service.runBotPatrolNow('b1');
		await service.claim('window:1', manual.run!.id);
		const stops: string[] = [];
		disposables.add(service.onDidRequestStop(request => stops.push(request.runId)));
		await service.deleteBotPatrols('b1');
		assert.deepStrictEqual({ definitions: state.stored!.definitions.length, stops: stops.length, view: await service.getBotPatrol('b1') }, {
			definitions: 0, stops: 1, view: { enabled: false, lookFor: '', gate: 'ok', otherPatrolsRunsPerDay: 0 },
		});
	});

	test('保存したファイルから Bot の見回りを読み戻す。ほかの kind の指紋は前と同じ', () => {
		const patrol: IParadisScheduledRunDefinition = {
			id: 'p1', name: 'リリース係 の見回り', enabled: true, schedule: '0 8-20/4 * * 1-5',
			target: { kind: 'bot', repositoryUri: '', repositoryName: 'リリース係', botId: 'b1' },
			agentId: '', prompt: '', dailyLimit: 4, createdAt: 1, updatedAt: 1,
		};
		const repository: IParadisScheduledRunDefinition = {
			id: 'd1', name: '依存の更新確認', enabled: true, schedule: '0 9 * * *',
			target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' },
			agentId: 'claude', prompt: '依存パッケージの更新を確認して', dailyLimit: 3, createdAt: 1, updatedAt: 1,
		};
		const parsed = paradisParseScheduledRunsState(JSON.stringify({ version: 1, definitions: [patrol, repository, { ...patrol, id: 'p2', target: { ...patrol.target, botId: '' } }], runs: [], lastEvaluatedAt: {} }));
		assert.deepStrictEqual({
			ids: parsed?.definitions.map(definition => definition.id),
			// 既存の定義の指紋が変わると、有効な定期実行が全部「外で書き換えられた」として無効になる
			repository: paradisScheduledRunDefinitionDigest(repository),
			newSpace: paradisScheduledRunDefinitionDigest({ ...repository, target: { kind: 'newSpace', repositoryUri: 'file:///repo', repositoryName: 'repo', baseRef: 'main' }, precheck: { command: 'true', timeoutSeconds: 60 } }),
			otherBot: paradisScheduledRunDefinitionDigest(patrol) !== paradisScheduledRunDefinitionDigest({ ...patrol, target: { ...patrol.target, botId: 'b2' } }),
		}, {
			ids: ['p1', 'd1'],
			repository: '19c9d770a2ca4224a653c2eaa2a643508d903e791eaf371c3a8521c56c3bc6a2',
			newSpace: 'ea4de2a13824086c39af01cf827f57a125d66c3ebb44b95863cbb1eaf40766f7',
			otherBot: true,
		});
	});
});
