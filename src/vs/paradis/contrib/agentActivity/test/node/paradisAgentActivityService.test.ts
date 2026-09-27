/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisSessionCatalogId } from '../../../sessionResume/node/paradisSessionResumeChannel.js';
import { PARADIS_SPACE_USAGE_OTHER_KEY, paradisActivityDayKey } from '../../common/paradisAgentActivity.js';
import { IParadisActivityWorkerEnvelope, ParadisActivityWorkerReply } from '../../common/paradisAgentActivityWorkerProtocol.js';
import { ParadisAgentActivityService } from '../../node/paradisAgentActivityService.js';
import { IParadisActivityWorker, ParadisAgentActivityWorkerHost } from '../../node/paradisAgentActivityWorkerHost.js';

const WORKER_PATH = FileAccess.asFileUri('vs/paradis/contrib/agentActivity/node/paradisAgentActivityWorkerMain.js').fsPath;

function claudeLines(cwd: string, prompt: string, answer: string, time: Date): string {
	const timestamp = time.toISOString();
	return [
		JSON.stringify({ type: 'user', timestamp, cwd, sessionId: 'a1', message: { role: 'user', content: prompt } }),
		JSON.stringify({ type: 'assistant', timestamp, cwd, sessionId: 'a1', requestId: `r-${answer.length}`, message: { id: `m-${answer.length}`, model: 'claude-opus-4', content: [{ type: 'text', text: answer }], usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
	].join('\n') + '\n';
}

suite('ParadisAgentActivityService', function () {
	this.timeout(20_000);
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	let claudeHome: string;
	let codexHome: string;
	let service: ParadisAgentActivityService;

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-activity-'));
		claudeHome = join(root, 'claude');
		codexHome = join(root, 'codex');
		await fs.mkdir(join(claudeHome, 'projects', '-work-repo'), { recursive: true });
		await fs.mkdir(join(codexHome, 'sessions', '2026', '09', '20'), { recursive: true });
		service = store.add(new ParadisAgentActivityService({
			worker: new ParadisAgentActivityWorkerHost(ParadisAgentActivityWorkerHost.workerFactory(WORKER_PATH), 10_000),
			indexDbPath: join(root, 'index', 'sessionIndex.sqlite'),
			claudeHome: () => claudeHome,
			codexHome: () => codexHome,
		}, new NullLogService()));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test('aggregates space usage in the worker and follows appended and deleted transcripts', async () => {
		const today = new Date();
		const day = paradisActivityDayKey(today);
		const transcript = join(claudeHome, 'projects', '-work-repo', 'a1.jsonl');
		await fs.writeFile(transcript, claudeLines('/work/repo/src', 'first', 'one', today));
		await fs.writeFile(join(codexHome, 'sessions', '2026', '09', '20', 'rollout-x.jsonl'), [
			JSON.stringify({ type: 'session_meta', timestamp: today.toISOString(), payload: { id: 'c1', cwd: '/elsewhere' } }),
			JSON.stringify({ type: 'event_msg', timestamp: today.toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 1 } } } }),
		].join('\n') + '\n');
		const request = { since: day, until: day, spaces: [{ key: 'repo', name: 'repo', roots: ['/work/repo'] }] };

		const first = await service.spaceUsage(request);
		await fs.appendFile(transcript, claudeLines('/work/repo/src', 'second', 'two!', today));
		const appended = await service.spaceUsage(request);
		await fs.rm(transcript);
		const deleted = await service.spaceUsage(request);
		const stats = await service.workStats({ since: day, until: day });

		const tokens = (result: typeof first) => Object.fromEntries(result.buckets.map(bucket => [bucket.key, Object.values(bucket.days[day] ?? {}).map(value => value.input + value.output)]));
		assert.deepStrictEqual({
			first: tokens(first),
			appended: tokens(appended),
			deleted: tokens(deleted),
			stats: { claude: stats.agents.claude.turns, codex: stats.agents.codex.sessions },
		}, {
			first: { repo: [15], [PARADIS_SPACE_USAGE_OTHER_KEY]: [8] },
			appended: { repo: [30], [PARADIS_SPACE_USAGE_OTHER_KEY]: [8] },
			deleted: { [PARADIS_SPACE_USAGE_OTHER_KEY]: [8] },
			// codex の会話には依頼が無いので、エージェント数には入らない
			stats: { claude: 0, codex: 0 },
		});
	});

	test('builds a trigram full-text index incrementally, follows deletions and retention, and can be deleted', async () => {
		const now = new Date();
		const live = join(claudeHome, 'projects', '-work-repo', 'live.jsonl');
		const old = join(claudeHome, 'projects', '-work-repo', 'old.jsonl');
		await fs.writeFile(live, claudeLines('/work/repo', 'ログイン画面のテストを追加して', 'テストを6件追加しました', now));
		await fs.writeFile(old, claudeLines('/work/repo', '古いログイン画面の話', 'はい', now));
		const longAgo = new Date(now.getTime() - 200 * 86_400_000);
		await fs.utimes(old, longAgo, longAgo);
		const options = { retentionDays: 90, includeToolOutput: false };

		await service.indexUpdate(options);
		const japanese = await service.indexSearch('ログイン画面');
		const shortTerm = await service.indexSearch('画面 テスト');
		await fs.appendFile(live, claudeLines('/work/repo', 'キャッシュ期限を調べて', 'TTL は5分でした', now));
		await service.indexUpdate(options);
		const appended = await service.indexSearch('キャッシュ期限');
		const status = await service.indexStatus();
		await fs.rm(live);
		await service.indexUpdate(options);
		const afterDelete = await service.indexSearch('キャッシュ期限');
		await service.indexDelete();
		const afterIndexDelete = await service.indexStatus();

		const liveId = paradisSessionCatalogId('claude', live);
		assert.deepStrictEqual({
			japanese: japanese.matches.map(match => [match.catalogId === liveId, match.matchCount]),
			covered: japanese.covered.map(id => id === liveId),
			shortTerm: shortTerm.matches.map(match => match.catalogId === liveId),
			appended: appended.matches.map(match => [match.catalogId === liveId, match.snippet]),
			status: { exists: status.exists, files: status.files, messages: status.messages },
			afterDelete,
			afterIndexDelete: afterIndexDelete.exists,
			databaseRemoved: await fs.stat(join(root, 'index', 'sessionIndex.sqlite')).then(() => false, () => true),
		}, {
			japanese: [[true, 1]],
			covered: [true],
			shortTerm: [true],
			appended: [[true, 'キャッシュ期限を調べて']],
			status: { exists: true, files: 1, messages: 4 },
			afterDelete: { covered: [], matches: [] },
			afterIndexDelete: false,
			databaseRemoved: true,
		});
	});
});

suite('ParadisAgentActivityWorkerHost', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class FakeWorker implements IParadisActivityWorker {
		readonly posted: IParadisActivityWorkerEnvelope[] = [];
		private readonly listeners = new Map<string, ((value: never) => void)[]>();
		terminated = false;
		postMessage(message: IParadisActivityWorkerEnvelope): void { this.posted.push(message); }
		on(event: string, listener: (value: never) => void): unknown {
			this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
			return this;
		}
		emit(event: 'message', value: ParadisActivityWorkerReply): void;
		emit(event: 'exit', value: number): void;
		emit(event: string, value: unknown): void {
			for (const listener of this.listeners.get(event) ?? []) {
				listener(value as never);
			}
		}
		async terminate(): Promise<number> { this.terminated = true; return 0; }
	}

	test('rejects pending requests when the worker exits and starts a new worker for the next request', async () => {
		const workers: FakeWorker[] = [];
		const host = store.add(new ParadisAgentActivityWorkerHost(() => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		}, 60_000));
		const first = host.request({ op: 'indexClose' });
		workers[0].emit('exit', 1);
		const firstError = await first.then(() => undefined, (error: Error) => error.message);
		const second = host.request<string>({ op: 'indexClose' });
		workers[1].emit('message', { id: workers[1].posted[0].id, ok: true, value: 'done' });
		assert.deepStrictEqual({ firstError, second: await second, workers: workers.length }, {
			firstError: 'The agent activity worker exited unexpectedly (code 1).',
			second: 'done',
			workers: 2,
		});
	});
});
