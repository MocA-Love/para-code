/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { bufferToStream, VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { IParadisRemoteCodexRolloutDiscoveryHost, ParadisRemoteCodexRolloutDiscovery, ParadisRemoteRolloutReport, paradisRolloutDayFolders } from '../../electron-browser/paradisRemoteCodexRolloutDiscovery.js';

// 昼の時刻にして、手元の地方時でも UTC でも日付をまたがないようにする
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const DAY = '2026/10/03';
const HOMES = [
	URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/u/.codex' }),
	URI.from({ scheme: 'vscode-remote', authority: 'ssh-remote+host', path: '/home/u/.codex-2' }),
];

interface IFakeRollout {
	/** `<ホーム>/sessions/<年>/<月>/<日>` の下の名前。 */
	readonly home?: string;
	readonly day?: string;
	readonly id: number;
	readonly mtime: number;
	readonly cwd: string;
	readonly createdAt: number;
	readonly subagent?: boolean;
	/** session_meta の `source` / `originator`（`codex exec` などを模す）。 */
	readonly source?: string;
	readonly originator?: string;
}

function threadId(n: number): string {
	return `0000000${n}-0000-0000-0000-000000000000`;
}

function pathOf(rollout: IFakeRollout): string {
	return `${rollout.home ?? '/home/u/.codex'}/sessions/${rollout.day ?? DAY}/rollout-2026-10-03T00-00-00-${threadId(rollout.id)}.jsonl`;
}

function fakeFileService(rollouts: readonly IFakeRollout[], reads: string[], resolves: string[] = []): Pick<IFileService, 'resolve' | 'readFileStream'> {
	// 呼ばれるたびに配列から作り直す（テストの途中で rollout が増える）
	const files = () => new Map(rollouts.map(rollout => [pathOf(rollout), rollout]));
	const children = (directory: string) => {
		const names = new Map<string, { isFile: boolean; mtime: number }>();
		for (const [path, rollout] of files()) {
			if (path.startsWith(`${directory}/`)) {
				const rest = path.slice(directory.length + 1);
				const slash = rest.indexOf('/');
				names.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? { isFile: true, mtime: rollout.mtime } : { isFile: false, mtime: 0 });
			}
		}
		return names;
	};
	return {
		resolve: (async (resource: URI) => {
			resolves.push(resource.path);
			const names = children(resource.path);
			if (names.size === 0) {
				throw new Error('not found');
			}
			return {
				resource,
				children: [...names].map(([name, entry]) => ({ resource: resource.with({ path: `${resource.path}/${name}` }), name, isFile: entry.isFile, isDirectory: !entry.isFile, mtime: entry.mtime })),
			};
		}) as unknown as IFileService['resolve'],
		readFileStream: (async (resource: URI) => {
			const rollout = files().get(resource.path);
			if (rollout === undefined) {
				throw new Error('not found');
			}
			reads.push(resource.path);
			const payload = {
				id: threadId(rollout.id),
				cwd: rollout.cwd,
				timestamp: new Date(rollout.createdAt).toISOString(),
				...(rollout.subagent === true ? { source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } : {}),
				...(rollout.source !== undefined ? { source: rollout.source } : {}),
				...(rollout.originator !== undefined ? { originator: rollout.originator } : {}),
			};
			return { value: bufferToStream(VSBuffer.fromString(`${JSON.stringify({ type: 'session_meta', payload })}\n{"type":"event_msg"}\n`)) };
		}) as unknown as IFileService['readFileStream'],
	};
}

suite('ParadisRemoteCodexRolloutDiscovery', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function create(rollouts: readonly IFakeRollout[], options: { readonly answer?: (token: string, path: string) => ParadisRemoteRolloutReport; readonly active?: () => boolean; readonly now?: () => number } = {}) {
		const reports: string[] = [];
		const reads: string[] = [];
		const resolves: string[] = [];
		const delays: number[] = [];
		const host: IParadisRemoteCodexRolloutDiscoveryHost = {
			fileService: fakeFileService(rollouts, reads, resolves),
			resolveCodexHomes: async () => HOMES,
			report: async (token, remotePath) => {
				reports.push(`${token} ${remotePath}`);
				return options.answer?.(token, remotePath) ?? 'accepted';
			},
			isActive: options.active,
			now: options.now ?? (() => NOW),
			schedule: (_callback, delayMs) => {
				delays.push(delayMs);
				return { dispose: () => { } };
			},
		};
		return { discovery: store.add(new ParadisRemoteCodexRolloutDiscovery(host)), reports, reads, resolves, delays };
	}

	// 作業ディレクトリが同じで起動後に作られた root の会話のうち一番古いものを、アカウント用のホームも
	// 含めて選ぶ。子の会話、別の場所の会話、起動より前に作られた会話、`codex exec` の会話は取らない。
	// 同じ場所の 2 つ目のペインは、1 つ目が知らせたものを避ける
	test('finds the root rollout started in the same directory after the command, in every Codex home', async () => {
		const { discovery, reports } = create([
			{ id: 1, mtime: NOW - 1_000, cwd: '/work/repo', createdAt: NOW - 2_000 },
			{ id: 2, mtime: NOW - 500, cwd: '/work/repo', createdAt: NOW - 1_000, subagent: true },
			{ id: 3, mtime: NOW - 400, cwd: '/work/other', createdAt: NOW - 1_000 },
			{ id: 4, mtime: NOW - 300, cwd: '/work/repo', createdAt: NOW - 60 * 60_000 },
			{ id: 5, home: '/home/u/.codex-2', mtime: NOW - 3_000, cwd: '/work/repo/', createdAt: NOW - 4_000 },
			{ id: 6, mtime: NOW - 200, cwd: '/work/repo', createdAt: NOW - 9_000, source: 'exec', originator: 'codex_exec' },
			{ id: 8, mtime: NOW - 200, cwd: '/work/repo', createdAt: NOW - 9_000, originator: 'codex_exec' },
		]);
		discovery.start('pane-1', '/work/repo/', 'new');
		await discovery.poll('pane-1');
		discovery.start('pane-2', '/work/repo', 'fork');
		await discovery.poll('pane-2');

		assert.deepStrictEqual(reports, [
			`pane-1 /home/u/.codex-2/sessions/${DAY}/rollout-2026-10-03T00-00-00-${threadId(5)}.jsonl`,
			`pane-2 /home/u/.codex/sessions/${DAY}/rollout-2026-10-03T00-00-00-${threadId(1)}.jsonl`,
		]);
	});

	// 受け付けた後は、それより後に作られた会話（/new）にだけ乗り換える。更新が新しいだけの別の会話には移らない
	test('only moves to a conversation created after the accepted one', async () => {
		const rollouts: IFakeRollout[] = [{ id: 1, mtime: NOW - 1_000, cwd: '/work/repo', createdAt: NOW - 2_000 }];
		const { discovery, reports } = create(rollouts);
		discovery.start('pane-1', '/work/repo', 'new');
		await discovery.poll('pane-1');
		// 起動後に作られたが、受け付けたものより前に作られた会話（更新だけが新しい）
		rollouts.push({ id: 2, mtime: NOW, cwd: '/work/repo', createdAt: NOW - 5_000 });
		await discovery.poll('pane-1');
		// /new で作られた会話
		rollouts.push({ id: 3, mtime: NOW, cwd: '/work/repo', createdAt: NOW - 500 });
		await discovery.poll('pane-1');
		// 受け付けた後の周回は、hook が届いたかを確かめるために同じものを知らせ直す
		assert.deepStrictEqual(reports.map(report => /-(?<id>[0-9a-f-]{36})\.jsonl$/.exec(report)?.groups?.id), [threadId(1), threadId(1), threadId(3)]);
	});

	// 再開は名前の thread id が一致する rollout だけ（古い日付のフォルダも遡る）。id の無い再開は探さない
	test('accepts a resumed conversation only by its thread id, and leaves an id-less resume to the hooks', async () => {
		const { discovery, reports } = create([
			{ id: 1, mtime: NOW, cwd: '/work/repo', createdAt: NOW - 60_000 },
			{ id: 7, day: '2026/08/15', mtime: NOW - 1_000, cwd: '/work/repo', createdAt: Date.UTC(2026, 7, 15) },
		]);
		discovery.start('pane-1', '/work/repo', 'resume', threadId(7));
		await discovery.poll('pane-1');
		discovery.start('pane-2', '/work/repo', 'resume');
		assert.deepStrictEqual({ reports, watched: discovery.watchedTokens }, {
			reports: [`pane-1 /home/u/.codex/sessions/2026/08/15/rollout-2026-10-03T00-00-00-${threadId(7)}.jsonl`],
			watched: ['pane-1'],
		});
	});

	// 子の会話は上位の件数に入れない（子が上位を埋めて親が漏れないように）
	test('does not let known child rollouts crowd out the parent', async () => {
		const rollouts: IFakeRollout[] = [{ id: 1, mtime: NOW - 10_000, cwd: '/work/repo', createdAt: NOW - 11_000 }];
		for (let n = 2; n <= 9; n++) {
			rollouts.push({ id: n, mtime: NOW - n, cwd: '/work/repo', createdAt: NOW - 5_000, subagent: true });
		}
		const { discovery, reports } = create(rollouts);
		discovery.start('pane-1', '/work/repo', 'new');
		await discovery.poll('pane-1'); // 1 回目は子を読んで覚える
		await discovery.poll('pane-1');
		assert.deepStrictEqual(reports, [`pane-1 /home/u/.codex/sessions/${DAY}/rollout-2026-10-03T00-00-00-${threadId(1)}.jsonl`]);
	});

	test('stops once the hooks arrive for the pane, and does not look while mobile is off', async () => {
		let active = true;
		const { discovery, reports } = create([
			{ id: 1, mtime: NOW, cwd: '/work/repo', createdAt: NOW },
		], { answer: () => 'hooked', active: () => active });
		discovery.start('pane-1', '/work/repo', 'new');
		await discovery.poll('pane-1');
		active = false;
		discovery.start('pane-2', '/work/repo', 'new');
		assert.deepStrictEqual({ reports: reports.length, watched: discovery.watchedTokens }, { reports: 1, watched: [] });
	});

	// 接続先の地方時は UTC-12 〜 UTC+14 のどれか分からないので、その範囲が触れる UTC の日付を全部見る
	test('covers every time zone the host could be in, around the UTC date', () => {
		const at = (hour: number) => Date.UTC(2026, 9, 3, hour, 0, 0);
		assert.deepStrictEqual({
			morning: paradisRolloutDayFolders(at(6) - 15_000, at(6)),
			afternoon: paradisRolloutDayFolders(at(13) - 15_000, at(13)),
		}, {
			morning: ['2026/10/02', '2026/10/03'],
			afternoon: ['2026/10/03', '2026/10/04'],
		});
	});

	// 再開する会話が見つからない間は、間隔を 5 秒 → 30 秒 → 2 分と伸ばし、古い日付まで遡る走査は 3 回で
	// やめて今日の前後のフォルダだけを見る。遡る上限はホームごとに数える
	test('backs off while a resumed conversation is missing and stops the deep scan after a few tries', async () => {
		const rollouts: IFakeRollout[] = [];
		// 1 つ目のホームには上限（120）より多い日付のフォルダがある
		for (let day = 0; day < 130; day++) {
			const date = new Date(Date.UTC(2026, 4, 1) + day * 24 * 60 * 60 * 1000);
			rollouts.push({ id: 1, day: `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`, mtime: 0, cwd: '/work/other', createdAt: 0 });
		}
		rollouts.push({ id: 2, home: '/home/u/.codex-2', day: '2026/01/01', mtime: 0, cwd: '/work/repo', createdAt: 0 });
		const { discovery, delays, resolves, reports } = create(rollouts);
		discovery.start('pane-1', '/work/repo', 'resume', threadId(9));
		const deepScans: number[] = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			resolves.length = 0;
			await discovery.poll('pane-1');
			deepScans.push(resolves.filter(path => path.endsWith('/sessions')).length);
		}
		// 2 つ目のホームの奥にある会話は、1 つ目のホームの走査で上限を使い切っても見つかる
		discovery.start('pane-2', '/work/repo', 'resume', threadId(2));
		await discovery.poll('pane-2');
		assert.deepStrictEqual({ delays: delays.slice(1, 6), deepScans, reports }, {
			delays: [5_000, 30_000, 120_000, 120_000, 120_000],
			deepScans: [2, 2, 2, 0, 0],
			reports: [`pane-2 /home/u/.codex-2/sessions/2026/01/01/rollout-2026-10-03T00-00-00-${threadId(2)}.jsonl`],
		});
	});
});
