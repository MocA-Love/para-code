/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import 'mocha';
import * as assert from 'assert';
import { commitRepositoriesForParking, IParadisParkingSnapshot, IParadisUnaccountedCandidate, paradisHasWorkingTreeBetween, paradisRepositoryBelongsToFolder, selectRepositoriesForUnifiedParking, selectUnaccountedForParking } from '../paradisUnaccountedToPark';

function candidate(root: string, rootRealPath?: string): IParadisUnaccountedCandidate {
	return { repository: { root, rootRealPath } };
}

/**
 * `../util`'s `isDescendant` pulls in the `vscode` module transitively, which isn't available
 * outside the extension host, so these tests exercise `selectUnaccountedForParking`'s own
 * filtering logic (bidirectional match, rootRealPath fallback) against a POSIX-path stand-in
 * with the same contract. `isDescendant` itself is covered wherever the extension host tests run.
 */
function isDescendant(parent: string, descendant: string): boolean {
	if (parent === descendant) {
		return true;
	}
	return descendant.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
}

function normalizedPathEquals(a: string, b: string): boolean {
	const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
	return normalize(a) === normalize(b);
}

function snapshot(
	currentFolderPaths: readonly string[],
	openRepositories: readonly IParadisUnaccountedCandidate[],
	activeRepositories: ReadonlySet<IParadisUnaccountedCandidate['repository']> = new Set(),
	removedRepositories: readonly (IParadisUnaccountedCandidate | undefined)[] = [],
): IParadisParkingSnapshot<IParadisUnaccountedCandidate> {
	return { currentFolderPaths, openRepositories, activeRepositories, removedRepositories };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
	let resolve: (value: T) => void;
	let reject: (error: Error) => void;
	const promise = new Promise<T>((complete, fail) => {
		resolve = complete;
		reject = fail;
	});
	return { promise, resolve: resolve!, reject: reject! };
}

suite('selectUnaccountedForParking', () => {

	test('keeps a repository whose root exactly matches a current folder', () => {
		const repo = candidate('/w/repo');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('parks a repository no current folder covers', () => {
		const repo = candidate('/other/repo');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, [repo]);
	});

	test('keeps a repository nested inside a current folder', () => {
		// e.g. a sibling worktree opened by auto-detection under the workspace folder.
		const repo = candidate('/w/repo/nested');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('keeps a repository that is an ancestor of the current folder', () => {
		// e.g. the workspace folder is a subdirectory of a parent repository.
		const repo = candidate('/w');
		const result = selectUnaccountedForParking([repo], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('matches through rootRealPath when the plain root disagrees with every folder', () => {
		const repo = candidate('/tmp/work', '/private/tmp/work');
		const result = selectUnaccountedForParking([repo], ['/private/tmp/work'], isDescendant);
		assert.deepStrictEqual(result, []);
	});

	test('parks only the candidates unaccounted for, keeping the rest', () => {
		const kept = candidate('/w/repo');
		const parked = candidate('/other/repo');
		const result = selectUnaccountedForParking([kept, parked], ['/w/repo'], isDescendant);
		assert.deepStrictEqual(result, [parked]);
	});

	test('parks every candidate when there are no current folders at all', () => {
		const repo = candidate('/w/repo');
		const result = selectUnaccountedForParking([repo], [], isDescendant);
		assert.deepStrictEqual(result, [repo]);
	});

	test('keeps logical and real-path aliases of a current folder', () => {
		const aliased = candidate('/tmp/repo', '/private/repo');
		const result = selectUnaccountedForParking(
			[aliased, aliased],
			['/tmp/repo/app', '/private/repo/app'],
			isDescendant,
		);
		assert.deepStrictEqual(result, []);
	});

	test('keeps exact aliases that differ only by case, separators, or trailing separators', () => {
		const repos = [
			candidate('/Users/Name/Repo'),
			candidate('C:\\Repo'),
			candidate('\\\\Server\\Share\\Repo'),
		];
		const result = selectUnaccountedForParking(
			repos,
			['/users/name/repo/', 'c:/repo/', '//server/share/repo/'],
			isDescendant,
			normalizedPathEquals,
		);
		assert.deepStrictEqual(result, []);
	});

	test('selects unified unaccounted repositories once in first-seen order', () => {
		const ancestor = candidate('/repo');
		const active = candidate('/active');
		const nested = candidate('/repo/packages/app/nested');
		const firstUnrelated = candidate('/other');
		const secondUnrelated = candidate('/another');
		const result = selectRepositoriesForUnifiedParking(
			[ancestor, active, firstUnrelated],
			[ancestor, active, nested, firstUnrelated, secondUnrelated],
			new Set([active.repository]),
			['/repo/packages/app'],
			isDescendant,
		);
		assert.deepStrictEqual(result, [firstUnrelated, secondUnrelated]);
	});

	test('does not commit when a newer workspace generation arrives during realpath resolution', async () => {
		const c = candidate('/spaces/c');
		let generation = 1;
		let latestSnapshot = snapshot(['/spaces/b'], [c]);
		const realpath = deferred<string | undefined>();
		let commits = 0;
		const resultPromise = commitRepositoriesForParking(
			() => latestSnapshot,
			() => generation === 1,
			() => realpath.promise,
			isDescendant,
			normalizedPathEquals,
			() => commits++,
		);

		generation++;
		latestSnapshot = snapshot(['/spaces/c'], [c]);
		realpath.resolve('/spaces/b');

		assert.deepStrictEqual({ result: await resultPromise, commits }, { result: { kind: 'stale' }, commits: 0 });
	});

	test('does not commit when current folders change while resolving realpaths', async () => {
		let latestSnapshot = snapshot(['/spaces/b'], []);
		const realpath = deferred<string | undefined>();
		let commits = 0;
		const resultPromise = commitRepositoriesForParking(
			() => latestSnapshot,
			() => true,
			() => realpath.promise,
			isDescendant,
			normalizedPathEquals,
			() => commits++,
		);

		latestSnapshot = snapshot(['/spaces/c'], []);
		realpath.resolve('/spaces/b');

		assert.deepStrictEqual({ result: await resultPromise, commits }, { result: { kind: 'stale' }, commits: 0 });
	});

	test('uses the latest visible-editor repositories before committing', async () => {
		const editorRepository = candidate('/other');
		let latestSnapshot = snapshot(['/workspace'], [editorRepository]);
		const realpath = deferred<string | undefined>();
		const committedRepositories: Array<readonly IParadisUnaccountedCandidate[]> = [];
		const resultPromise = commitRepositoriesForParking(
			() => latestSnapshot,
			() => true,
			() => realpath.promise,
			isDescendant,
			normalizedPathEquals,
			repositories => { committedRepositories.push(repositories); },
		);

		latestSnapshot = snapshot(['/workspace'], [editorRepository], new Set([editorRepository.repository]));
		realpath.resolve('/workspace');

		assert.deepStrictEqual(
			{ result: await resultPromise, committedRepositories },
			{ result: { kind: 'committed', skippedParking: false, commitResult: undefined }, committedRepositories: [[]] },
		);
	});

	test('keeps a logical-root repository when only the current real path matches it', async () => {
		const logicalRoot = candidate('/canonical/repo');
		const committedRepositories: Array<readonly IParadisUnaccountedCandidate[]> = [];
		const result = await commitRepositoriesForParking(
			() => snapshot(['/logical/repo'], [logicalRoot]),
			() => true,
			() => Promise.resolve('/canonical/repo'),
			isDescendant,
			normalizedPathEquals,
			repositories => { committedRepositories.push(repositories); },
		);
		assert.deepStrictEqual({ result, committedRepositories }, { result: { kind: 'committed', skippedParking: false, commitResult: undefined }, committedRepositories: [[]] });
	});

	test('keeps a real-root repository when only the current logical path matches it', async () => {
		const realRoot = candidate('/other/repo', '/logical/repo');
		const committedRepositories: Array<readonly IParadisUnaccountedCandidate[]> = [];
		const result = await commitRepositoriesForParking(
			() => snapshot(['/logical/repo'], [realRoot]),
			() => true,
			() => Promise.resolve('/canonical/repo'),
			isDescendant,
			normalizedPathEquals,
			repositories => { committedRepositories.push(repositories); },
		);
		assert.deepStrictEqual({ result, committedRepositories }, { result: { kind: 'committed', skippedParking: false, commitResult: undefined }, committedRepositories: [[]] });
	});

	test('skips parking but commits latest folders when any current folder realpath is unavailable', async () => {
		const canonicalOnly = candidate('/canonical/repo');
		const commits: Array<{ repositories: readonly IParadisUnaccountedCandidate[]; folders: readonly string[] }> = [];
		const result = await commitRepositoriesForParking(
			() => snapshot(['/logical/repo'], [canonicalOnly]),
			() => true,
			() => Promise.resolve(undefined),
			isDescendant,
			normalizedPathEquals,
			(repositories, folders) => { commits.push({ repositories, folders }); },
		);
		assert.deepStrictEqual(result, { kind: 'committed', skippedParking: true, commitResult: undefined });
		assert.deepStrictEqual(commits, [{ repositories: [], folders: ['/logical/repo'] }]);
	});

	test('skips parking but commits latest folders when current folder realpath rejects', async () => {
		const commits: Array<{ repositories: readonly IParadisUnaccountedCandidate[]; folders: readonly string[] }> = [];
		const result = await commitRepositoriesForParking(
			() => snapshot(['/logical/repo'], [candidate('/canonical/repo')]),
			() => true,
			() => Promise.reject(new Error('realpath failed')),
			isDescendant,
			normalizedPathEquals,
			(repositories, folders) => { commits.push({ repositories, folders }); },
		);
		assert.deepStrictEqual(result, { kind: 'committed', skippedParking: true, commitResult: undefined });
		assert.deepStrictEqual(commits, [{ repositories: [], folders: ['/logical/repo'] }]);
	});

	test('does not commit when generation changes at the latest-snapshot boundary', async () => {
		let generation = 1;
		let snapshots = 0;
		let parks = 0;
		const result = await commitRepositoriesForParking(
			() => {
				if (snapshots++ === 1) {
					generation++;
				}
				return snapshot(['/workspace'], [candidate('/other')]);
			},
			() => generation === 1,
			() => Promise.resolve('/workspace'),
			isDescendant,
			normalizedPathEquals,
			repositories => parks += repositories.length,
		);
		assert.deepStrictEqual({ result, parks }, { result: { kind: 'stale' }, parks: 0 });
	});

	test('calls the synchronous commit callback exactly once', async () => {
		let commits = 0;
		const result = await commitRepositoriesForParking(
			() => snapshot(['/workspace'], [candidate('/other')]),
			() => true,
			() => Promise.resolve('/workspace'),
			isDescendant,
			normalizedPathEquals,
			() => { commits++; },
		);
		assert.deepStrictEqual({ result, commits }, { result: { kind: 'committed', skippedParking: false, commitResult: undefined }, commits: 1 });
	});

	test('commits latest B and C folders after the stale B handler is discarded', async () => {
		const opened = new Set(['/a']);
		const openedByCommit: string[] = [];
		const commitLatestFolders = (_repositories: readonly IParadisUnaccountedCandidate[], folders: readonly string[]) => {
			for (const folder of folders) {
				if (!opened.has(folder)) {
					opened.add(folder);
					openedByCommit.push(folder);
				}
			}
		};
		let generation = 1;
		let latestSnapshot = snapshot(['/a', '/b'], []);
		const bRealpath = deferred<string | undefined>();
		const bResult = commitRepositoriesForParking(
			() => latestSnapshot,
			() => generation === 1,
			() => bRealpath.promise,
			isDescendant,
			normalizedPathEquals,
			commitLatestFolders,
		);

		generation++;
		latestSnapshot = snapshot(['/a', '/b', '/c'], []);
		const cResult = await commitRepositoriesForParking(
			() => latestSnapshot,
			() => generation === 2,
			folder => Promise.resolve(folder),
			isDescendant,
			normalizedPathEquals,
			commitLatestFolders,
		);
		bRealpath.resolve('/b');

		assert.deepStrictEqual(
			{ bResult: await bResult, cResult, openedByCommit },
			{ bResult: { kind: 'stale' }, cResult: { kind: 'committed', skippedParking: false, commitResult: undefined }, openedByCommit: ['/b', '/c'] },
		);
	});

	test('returns synchronously started B and C open promises for the handler to await', async () => {
		const bOpen = deferred<void>();
		const cOpen = deferred<void>();
		const opens = new Map([['/b', bOpen], ['/c', cOpen]]);
		const started: string[] = [];
		const result = await commitRepositoriesForParking(
			() => snapshot(['/a', '/b', '/c'], []),
			() => true,
			folder => Promise.resolve(folder),
			isDescendant,
			normalizedPathEquals,
			(_repositories, folders) => folders
				.filter(folder => folder !== '/a')
				.map(folder => {
					started.push(folder);
					return opens.get(folder)!.promise;
				}),
		);

		assert.deepStrictEqual({ started, result }, {
			started: ['/b', '/c'],
			result: { kind: 'committed', skippedParking: false, commitResult: [bOpen.promise, cOpen.promise] },
		});
		if (result.kind !== 'committed') {
			assert.fail('expected committed result');
		}

		let completed = false;
		const handlerCompletion = Promise.all(result.commitResult).then(() => completed = true);
		bOpen.resolve();
		await Promise.resolve();
		assert.strictEqual(completed, false);
		cOpen.resolve();
		await handlerCompletion;
		assert.strictEqual(completed, true);
	});

	test('lets the handler catch a rejection from a synchronously started open', async () => {
		const open = deferred<void>();
		const expectedError = new Error('open failed');
		const logged: Error[] = [];
		const handler = async () => {
			try {
				const result = await commitRepositoriesForParking(
					() => snapshot(['/workspace'], []),
					() => true,
					folder => Promise.resolve(folder),
					isDescendant,
					normalizedPathEquals,
					() => [open.promise],
				);
				if (result.kind === 'committed') {
					await Promise.all(result.commitResult);
				}
			} catch (error) {
				logged.push(error as Error);
			}
		};

		const handlerCompletion = handler();
		await Promise.resolve();
		open.reject(expectedError);
		await handlerCompletion;
		assert.deepStrictEqual(logged, [expectedError]);
	});
});

/**
 * 入れ子のワークツリー（メインのリポジトリの中に `git worktree add` したもの）。`.git` を持つフォルダの
 * 集合で、git の「いちばん近い `.git` が持ち主」を再現する。
 */
function workingTreeBetween(dotGitFolders: readonly string[]) {
	const posixDirname = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 1));
	return paradisHasWorkingTreeBetween(folder => dotGitFolders.includes(folder), posixDirname, isDescendant, normalizedPathEquals);
}

suite('paradis nested worktree spaces', () => {
	// メインのリポジトリと、その中に入れ子で置いたワークツリー A、入れ子のサブモジュール、入れ子の独立したリポジトリ。
	const main = { root: '/w/main', kind: 'repository' };
	const worktreeA = { root: '/w/main/.worktrees/a', kind: 'worktree' };
	const submodule = { root: '/w/main/vendor/sub', kind: 'submodule' };
	const nestedRepository = { root: '/w/main/tools/other', kind: 'repository' };
	const between = workingTreeBetween(['/w/main', '/w/main/.worktrees/a', '/w/main/vendor/sub', '/w/main/tools/other']);
	const belongs = (repository: typeof main, folder: string) => paradisRepositoryBelongsToFolder(repository, folder, isDescendant, normalizedPathEquals, between);

	test('puts each repository only in its own space, while nested submodules and nested repositories stay with the outer space', () => {
		assert.deepStrictEqual({
			mainSpace: [main, worktreeA, submodule, nestedRepository].filter(repository => belongs(repository, '/w/main')).map(repository => repository.root),
			worktreeSpace: [main, worktreeA, submodule, nestedRepository].filter(repository => belongs(repository, '/w/main/.worktrees/a')).map(repository => repository.root),
			// リポジトリ内のサブフォルダだけを開いたスペースは、今までどおり外側のリポジトリに属する。
			subfolderOfMain: belongs(main, '/w/main/src'),
			subfolderOfWorktree: { main: belongs(main, '/w/main/.worktrees/a/src'), worktree: belongs(worktreeA, '/w/main/.worktrees/a/src') },
		}, {
			mainSpace: ['/w/main', '/w/main/vendor/sub', '/w/main/tools/other'],
			worktreeSpace: ['/w/main/.worktrees/a'],
			subfolderOfMain: true,
			subfolderOfWorktree: { main: false, worktree: true },
		});
	});

	test('parks the nested worktree when going back to the main space, and the main repository when going to the worktree space', () => {
		const open = [main, worktreeA, submodule].map(repository => ({ repository }));
		assert.deepStrictEqual({
			toMain: selectUnaccountedForParking(open, ['/w/main'], isDescendant, normalizedPathEquals, between).map(candidate => candidate.repository.root),
			toWorktree: selectUnaccountedForParking(open, ['/w/main/.worktrees/a'], isDescendant, normalizedPathEquals, between).map(candidate => candidate.repository.root),
		}, {
			toMain: ['/w/main/.worktrees/a'],
			toWorktree: ['/w/main', '/w/main/vendor/sub'],
		});
	});

	// 初めてワークツリー A のスペースへ行くとき、A のリポジトリはまだ開いていない。外側のメインを
	// 待避しないと、フォルダが「開いているリポジトリ（メイン）の中」と見なされて A が開かれず、
	// メインの変更が出ていた。`.git` の有無で決めるので、A が開く前でもメインを待避する。
	test('parks the outer main repository on the first visit to a nested worktree space, before the worktree repository is open', async () => {
		const mainCandidate = { repository: main };
		const result = await commitRepositoriesForParking(
			() => snapshot(['/w/main/.worktrees/a'], [mainCandidate]),
			() => true,
			folder => Promise.resolve(folder),
			isDescendant,
			normalizedPathEquals,
			repositoriesToPark => repositoriesToPark.map(candidate => candidate.repository.root),
			between,
		);
		assert.deepStrictEqual(result, { kind: 'committed', skippedParking: false, commitResult: ['/w/main'] });
	});

	// リポジトリでないフォルダ（ワークツリーを並べて置く場所など）をスペースにしたときは、中のワークツリーは
	// 今までどおりそのスペースに属する。外すのは、間にメインの作業ツリーがあるときだけ。
	test('keeps a worktree in a space whose folder is not a repository', () => {
		const looseWorktree = { root: '/w/worktrees/b', kind: 'worktree' };
		const looseBetween = workingTreeBetween(['/w/worktrees/b']);
		assert.deepStrictEqual({
			container: paradisRepositoryBelongsToFolder(looseWorktree, '/w/worktrees', isDescendant, normalizedPathEquals, looseBetween),
			grandparent: paradisRepositoryBelongsToFolder(looseWorktree, '/w', isDescendant, normalizedPathEquals, looseBetween),
			nestedUnderMainFromAbove: belongs(worktreeA, '/w'),
		}, { container: true, grandparent: true, nestedUnderMainFromAbove: false });
	});

	test('finds a working tree anywhere between the outer root and the folder, but not the outer root itself', () => {
		assert.deepStrictEqual({
			atFolder: between('/w/main', '/w/main/.worktrees/a'),
			aboveFolder: between('/w/main', '/w/main/.worktrees/a/src/deep'),
			onlyOuter: between('/w/main', '/w/main/src/deep'),
			sameFolder: between('/w/main', '/w/main'),
			outside: between('/w/main', '/elsewhere'),
			// 1 段上へずらした範囲: 外側を含めて、フォルダ自身は含めない。
			includeOuter: between('/w/main', '/w/main/.worktrees/a', true),
			includeOuterAboveRoot: between('/w', '/w/main/.worktrees/a', true),
			includeOuterNothingAbove: between('/w/main/.worktrees', '/w/main/.worktrees/a', true),
		}, { atFolder: true, aboveFolder: true, onlyOuter: false, sameFolder: false, outside: false, includeOuter: true, includeOuterAboveRoot: true, includeOuterNothingAbove: false });
	});
});
