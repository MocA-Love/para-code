/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import 'mocha';
import * as assert from 'assert';
import { coordinateRepositoriesForParking, IParadisParkingSnapshot, IParadisUnaccountedCandidate, selectRepositoriesForUnifiedParking, selectUnaccountedForParking } from '../paradisUnaccountedToPark';

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

	test('returns stale when a newer workspace generation arrives during realpath resolution', async () => {
		const c = candidate('/spaces/c');
		let generation = 1;
		let latestSnapshot = snapshot(['/spaces/b'], [c]);
		const realpath = deferred<string | undefined>();
		const resultPromise = coordinateRepositoriesForParking(
			() => latestSnapshot,
			() => generation === 1,
			() => realpath.promise,
			isDescendant,
			normalizedPathEquals,
		);

		generation++;
		latestSnapshot = snapshot(['/spaces/c'], [c]);
		realpath.resolve('/spaces/b');

		assert.deepStrictEqual(await resultPromise, { kind: 'stale' });
	});

	test('returns stale when current folders change while resolving realpaths', async () => {
		let latestSnapshot = snapshot(['/spaces/b'], []);
		const realpath = deferred<string | undefined>();
		const resultPromise = coordinateRepositoriesForParking(
			() => latestSnapshot,
			() => true,
			() => realpath.promise,
			isDescendant,
			normalizedPathEquals,
		);

		latestSnapshot = snapshot(['/spaces/c'], []);
		realpath.resolve('/spaces/b');

		assert.deepStrictEqual(await resultPromise, { kind: 'stale' });
	});

	test('uses the latest visible-editor repositories after realpath resolution', async () => {
		const editorRepository = candidate('/other');
		let latestSnapshot = snapshot(['/workspace'], [editorRepository]);
		const realpath = deferred<string | undefined>();
		const resultPromise = coordinateRepositoriesForParking(
			() => latestSnapshot,
			() => true,
			() => realpath.promise,
			isDescendant,
			normalizedPathEquals,
		);

		latestSnapshot = snapshot(['/workspace'], [editorRepository], new Set([editorRepository.repository]));
		realpath.resolve('/workspace');

		assert.deepStrictEqual(await resultPromise, { kind: 'ready', repositoriesToPark: [] });
	});

	test('keeps a logical-root repository when only the current real path matches it', async () => {
		const logicalRoot = candidate('/canonical/repo');
		const result = await coordinateRepositoriesForParking(
			() => snapshot(['/logical/repo'], [logicalRoot]),
			() => true,
			() => Promise.resolve('/canonical/repo'),
			isDescendant,
			normalizedPathEquals,
		);
		assert.deepStrictEqual(result, { kind: 'ready', repositoriesToPark: [] });
	});

	test('keeps a real-root repository when only the current logical path matches it', async () => {
		const realRoot = candidate('/other/repo', '/logical/repo');
		const result = await coordinateRepositoriesForParking(
			() => snapshot(['/logical/repo'], [realRoot]),
			() => true,
			() => Promise.resolve('/canonical/repo'),
			isDescendant,
			normalizedPathEquals,
		);
		assert.deepStrictEqual(result, { kind: 'ready', repositoriesToPark: [] });
	});

	test('fails safe without parking when any current folder realpath is unavailable', async () => {
		const canonicalOnly = candidate('/canonical/repo');
		const result = await coordinateRepositoriesForParking(
			() => snapshot(['/logical/repo'], [canonicalOnly]),
			() => true,
			() => Promise.resolve(undefined),
			isDescendant,
			normalizedPathEquals,
		);
		assert.deepStrictEqual(result, { kind: 'skipParking' });
	});

	test('fails safe without parking when current folder realpath rejects', async () => {
		const result = await coordinateRepositoriesForParking(
			() => snapshot(['/logical/repo'], [candidate('/canonical/repo')]),
			() => true,
			() => Promise.reject(new Error('realpath failed')),
			isDescendant,
			normalizedPathEquals,
		);
		assert.deepStrictEqual(result, { kind: 'skipParking' });
	});
});
