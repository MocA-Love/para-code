/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { Emitter } from '../../../../../base/common/event.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import type { IParadisAgentHomes } from '../../../agentBrowser/node/paradisAgentHome.js';
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
	let codexHomes: () => readonly string[];
	let resolveAgentHomes: (cwd: string) => IParadisAgentHomes;
	let service: ParadisAgentActivityService;
	let indexDbPath: string;
	let settings: { enabled?: boolean; retentionDays?: number; includeToolOutput?: boolean };
	let settingsChanged: Emitter<void>;

	function createService(): ParadisAgentActivityService {
		return new ParadisAgentActivityService({
			worker: new ParadisAgentActivityWorkerHost(ParadisAgentActivityWorkerHost.workerFactory(WORKER_PATH), 10_000),
			indexDbPath,
			claudeHome: () => claudeHome,
			codexHomes: () => codexHomes(),
			resolveAgentHomes: cwd => resolveAgentHomes(cwd),
			indexSettings: () => settings,
			onDidChangeIndexSettings: settingsChanged.event,
		}, new NullLogService());
	}

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'paradis-activity-'));
		claudeHome = join(root, 'claude');
		codexHome = join(root, 'codex');
		codexHomes = () => [codexHome];
		resolveAgentHomes = cwd => ({ claude: claudeHome, codex: codexHome, matchCwd: cwd });
		await fs.mkdir(join(claudeHome, 'projects', '-work-repo'), { recursive: true });
		await fs.mkdir(join(codexHome, 'sessions', '2026', '09', '20'), { recursive: true });
		indexDbPath = join(root, 'index', 'sessionIndex.sqlite');
		settings = {};
		settingsChanged = store.add(new Emitter<void>());
		service = store.add(createService());
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

	// Codex のアカウントごとのホーム（~/.codex-2 等）と、WSL のスペースのディストロ側のホームも読む。
	// 切り替えた2つのホームの間でハードリンクした会話は1回だけ数える。
	test('reads every Codex home and WSL homes of the spaces, counting hard-linked conversations once', async () => {
		const today = new Date();
		const day = paradisActivityDayKey(today);
		const rollout = (cwd: string, input: number) => [
			JSON.stringify({ type: 'session_meta', timestamp: today.toISOString(), payload: { id: `c-${input}`, cwd } }),
			JSON.stringify({ type: 'event_msg', timestamp: today.toISOString(), payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1 } } } }),
		].join('\n') + '\n';
		const secondHome = join(root, 'codex-2');
		const wslClaude = join(root, 'wsl', 'claude');
		const wslCodex = join(root, 'wsl', 'codex');
		for (const dir of [join(secondHome, 'sessions', '2026', '09', '20'), join(wslCodex, 'sessions', '2026', '09', '20'), wslClaude]) {
			await fs.mkdir(dir, { recursive: true });
		}
		const shared = join(codexHome, 'sessions', '2026', '09', '20', 'rollout-shared.jsonl');
		await fs.writeFile(shared, rollout('/work/repo', 7));
		await fs.link(shared, join(secondHome, 'sessions', '2026', '09', '20', 'rollout-shared.jsonl'));
		await fs.writeFile(join(secondHome, 'sessions', '2026', '09', '20', 'rollout-second.jsonl'), rollout('/work/repo', 3));
		await fs.writeFile(join(wslCodex, 'sessions', '2026', '09', '20', 'rollout-wsl.jsonl'), rollout('/home/u/repo', 5));
		codexHomes = () => [codexHome, secondHome];
		resolveAgentHomes = cwd => cwd === '/wsl/repo'
			? { claude: wslClaude, codex: wslCodex, matchCwd: '/home/u/repo', wsl: { host: 'wsl.localhost', distro: 'Ubuntu', homeUncPath: '\\\\wsl.localhost\\Ubuntu\\home\\u', linuxCwd: '/home/u/repo' } }
			: { claude: claudeHome, codex: codexHome, matchCwd: cwd };

		const result = await service.spaceUsage({ since: day, until: day, spaces: [{ key: 'repo', name: 'repo', roots: ['/work/repo'] }, { key: 'wsl', name: 'wsl', roots: ['/wsl/repo'] }] });
		assert.deepStrictEqual({
			tokens: Object.fromEntries(result.buckets.map(bucket => [bucket.key, Object.values(bucket.days[day] ?? {}).map(value => value.input + value.output)])),
			scannedFiles: result.scannedFiles,
		}, { tokens: { repo: [12], wsl: [6] }, scannedFiles: 3 });
	});

	test('builds a trigram full-text index incrementally, follows deletions and retention, and can be deleted', async () => {
		const now = new Date();
		const live = join(claudeHome, 'projects', '-work-repo', 'live.jsonl');
		const old = join(claudeHome, 'projects', '-work-repo', 'old.jsonl');
		await fs.writeFile(live, claudeLines('/work/repo', 'ログイン画面のテストを追加して', 'テストを6件追加しました', now));
		await fs.writeFile(old, claudeLines('/work/repo', '古いログイン画面の話', 'はい', now));
		const longAgo = new Date(now.getTime() - 200 * 86_400_000);
		await fs.utimes(old, longAgo, longAgo);
		const liveId = paradisSessionCatalogId('claude', live);
		const oldId = paradisSessionCatalogId('claude', old);

		await service.indexUpdate();
		const japanese = await service.indexSearch('ログイン画面', [liveId, oldId]);
		const twoTerms = await service.indexSearch('ログイン画面 追加しました', [liveId]);
		await fs.appendFile(live, claudeLines('/work/repo', 'キャッシュ期限を調べて', 'TTL は5分でした', now));
		await service.indexUpdate();
		const appended = await service.indexSearch('キャッシュ期限', [liveId]);
		const status = await service.indexStatus();
		await fs.rm(live);
		await service.indexUpdate();
		const afterDelete = await service.indexSearch('キャッシュ期限', [liveId]);
		await service.indexDelete();
		const afterIndexDelete = await service.indexStatus();

		assert.deepStrictEqual({
			japanese: { uncovered: japanese.uncovered.map(id => id === oldId), matches: japanese.matches.map(match => [match.catalogId === liveId, match.terms, match.matchCount]) },
			twoTerms: twoTerms.matches.map(match => match.terms),
			appended: appended.matches.map(match => [match.catalogId === liveId, match.snippet]),
			status: { exists: status.exists, files: status.files, messages: status.messages },
			afterDelete: { uncovered: afterDelete.uncovered.length, matches: afterDelete.matches.length },
			afterIndexDelete: afterIndexDelete.exists,
			databaseRemoved: await fs.stat(indexDbPath).then(() => false, () => true),
		}, {
			// 保存日数を過ぎた会話は索引に入らず、従来の検索に回る
			japanese: { uncovered: [true], matches: [[true, [0], 1]] },
			// 語ごとに、本文のどの語に一致したかを返す（AND はセッション情報と合わせて画面側で取る）
			twoTerms: [[0, 1]],
			appended: [[true, 'キャッシュ期限を調べて']],
			status: { exists: true, files: 1, messages: 4 },
			afterDelete: { uncovered: 1, matches: 0 },
			afterIndexDelete: false,
			databaseRemoved: true,
		});
	});

	test('keeps the index owned by this user, drops shell output unless tool output is included, and rebuilds when that setting turns off', async () => {
		const now = new Date();
		const transcript = join(claudeHome, 'projects', '-work-repo', 'shell.jsonl');
		const shell = '<bash-input>cat .env</bash-input><bash-stdout>SECRET_TOKEN=abcdef</bash-stdout><bash-stderr>warning text</bash-stderr>';
		await fs.writeFile(transcript, claudeLines('/work/repo', shell, 'ok', now));
		const id = paradisSessionCatalogId('claude', transcript);

		settings.includeToolOutput = true;
		await service.indexUpdate();
		const withOutput = await service.indexSearch('SECRET_TOKEN', [id]);
		settings.includeToolOutput = false;
		settingsChanged.fire();
		await service.whenIndexReconciled();
		const afterSwitch = await service.indexStatus();
		await service.indexUpdate();
		const withoutOutput = await service.indexSearch('SECRET_TOKEN', [id]);
		const command = await service.indexSearch('cat .env', [id]);
		const modes = process.platform === 'win32' ? [] : [(await fs.stat(indexDbPath)).mode & 0o777, (await fs.stat(join(root, 'index'))).mode & 0o777];

		assert.deepStrictEqual({
			withOutput: withOutput.matches.length,
			afterSwitch: afterSwitch.files,
			withoutOutput: withoutOutput.matches.length,
			command: command.matches.length,
			modes,
		}, {
			withOutput: 1,
			// ツール出力を入れない設定に変わった時点で、会話ログを読まずに索引を作り直す
			afterSwitch: 0,
			withoutOutput: 0,
			command: 1,
			modes: process.platform === 'win32' ? [] : [0o600, 0o700],
		});
	});

	test('reads a transcript from the start again when it was rewritten in place and does not duplicate its messages', async () => {
		const now = new Date();
		const transcript = join(claudeHome, 'projects', '-work-repo', 'rewrite.jsonl');
		await fs.writeFile(transcript, claudeLines('/work/repo', '最初の依頼です', 'はい', now));
		const id = paradisSessionCatalogId('claude', transcript);
		await service.indexUpdate();
		// 同じファイル（inode）のまま中身を書き直し、元の長さより伸ばす
		const handle = await fs.open(transcript, 'r+');
		await handle.truncate(0);
		await handle.write(claudeLines('/work/repo', '書き直した依頼です。ずっと長い本文になっています', 'はいはい', now), 0);
		await handle.close();
		await service.indexUpdate();
		const oldText = await service.indexSearch('最初の依頼', [id]);
		const newText = await service.indexSearch('書き直した依頼', [id]);
		const status = await service.indexStatus();
		assert.deepStrictEqual({ oldText: oldText.matches.length, newText: newText.matches.length, messages: status.messages }, { oldText: 0, newText: 1, messages: 2 });
	});

	test('deletes an existing index at startup when the setting is off and refuses to rebuild it', async () => {
		const transcript = join(claudeHome, 'projects', '-work-repo', 'off.jsonl');
		await fs.writeFile(transcript, claudeLines('/work/repo', '索引に入る依頼', 'はい', new Date()));
		await service.indexUpdate();
		const before = await fs.stat(indexDbPath).then(() => true, () => false);
		service.dispose();

		settings.enabled = false;
		const restarted = store.add(createService());
		await restarted.whenIndexReconciled();
		const afterStartup = await fs.stat(indexDbPath).then(() => true, () => false);
		const update = await restarted.indexUpdate();
		const search = await restarted.indexSearch('索引に入る', ['x']);
		assert.deepStrictEqual({ before, afterStartup, update, search }, {
			before: true, afterStartup: false, update: undefined, search: { terms: [], uncovered: ['x'], matches: [] },
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

	test('stops a worker that does not answer in time, so the requests queued behind it are not stuck', async () => {
		const workers: FakeWorker[] = [];
		const host = store.add(new ParadisAgentActivityWorkerHost(() => {
			const worker = new FakeWorker();
			workers.push(worker);
			return worker;
		}, 60_000));
		const stuck = host.request({ op: 'indexClose' }, 10);
		const answered = host.request<string>({ op: 'indexClose' }, 60_000);
		workers[0].emit('message', { id: workers[0].posted[1].id, ok: true, value: 'quick' });
		const errors = await Promise.all([stuck, answered].map(request => request.then(value => value, (error: Error) => error.message)));
		const next = host.request<string>({ op: 'indexClose' });
		workers[1].emit('message', { id: workers[1].posted[0].id, ok: true, value: 'done' });
		assert.deepStrictEqual({ errors, next: await next, terminated: workers[0].terminated, workers: workers.length }, {
			errors: [`The agent activity worker did not answer 'indexClose' within 10ms.`, 'quick'],
			next: 'done',
			terminated: true,
			workers: 2,
		});
	});

	test('splits a parse batch that times out, and stops reading a transcript that keeps timing out until it changes', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'paradis-activity-timeout-'));
		try {
			const project = join(root, 'claude', 'projects', '-work-repo');
			await fs.mkdir(project, { recursive: true });
			const line = JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), cwd: '/work/repo', message: { role: 'user', content: 'x' } }) + '\n';
			await fs.writeFile(join(project, 'small.jsonl'), line);
			await fs.writeFile(join(project, 'huge.jsonl'), line);
			const requests: { files: number; huge: boolean }[] = [];
			// 「huge」を含む集計には答えない worker（読み込みが固まった状態）
			class StuckOnHugeWorker extends FakeWorker {
				override postMessage(message: IParadisActivityWorkerEnvelope): void {
					super.postMessage(message);
					if (message.request.op !== 'parse') {
						return;
					}
					const files = message.request.files;
					const huge = files.some(file => file.path.endsWith('huge.jsonl'));
					requests.push({ files: files.length, huge });
					if (!huge) {
						setTimeout(() => this.emit('message', { id: message.id, ok: true, value: files.map(() => null) }), 0);
					}
				}
			}
			const service = store.add(new ParadisAgentActivityService({
				worker: new ParadisAgentActivityWorkerHost(() => new StuckOnHugeWorker(), 60_000),
				indexDbPath: join(root, 'index.sqlite'),
				claudeHome: () => join(root, 'claude'),
				codexHomes: () => [join(root, 'codex')],
				resolveAgentHomes: cwd => ({ claude: join(root, 'claude'), codex: join(root, 'codex'), matchCwd: cwd }),
				indexSettings: () => ({ enabled: false }),
				parseTimeoutMs: () => 20,
			}, new NullLogService()));
			await service.whenIndexReconciled();
			const day = paradisActivityDayKey(new Date());
			for (let round = 0; round < 3; round++) {
				await service.workStats({ since: day, until: day });
			}
			assert.deepStrictEqual(requests, [
				{ files: 2, huge: true }, { files: 1, huge: requests[1].huge }, { files: 1, huge: !requests[1].huge },
				{ files: 2, huge: true }, { files: 1, huge: requests[1].huge }, { files: 1, huge: !requests[1].huge },
				// 2回続けて時間切れになったファイルは、中身が変わるまで読まない
				{ files: 1, huge: false },
			]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
