# Git Repository Parking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a workspace-folder switch from parking the repository that owns the new workspace, including ancestor repositories and logical/real-path aliases, while still parking truly unaccounted repositories once.

**Architecture:** Replace the current two-pass mutation with one gather-then-decide pass. Gather removed-folder repositories and all open repositories, remove active-editor repositories, deduplicate candidates, resolve both logical and canonical paths for every current workspace folder, run the existing bidirectional containment predicate once, and only then call `park()`.

**Tech Stack:** TypeScript, VS Code Git extension model, Node path/realpath, Mocha TDD tests.

**Spec:** `docs/superpowers/specs/2026-08-24-regression-resource-mobile-audit-design.md`

## Global Constraints

- Use TDD and observe the focused compiled JavaScript test fail before changing production code.
- Preserve parking-lot LRU behavior, repository open/unpark behavior, visible-editor protection, workspace trust handling, and error logging.
- Resolve current workspace real paths through the existing cached `getWorkspaceFolderRealPath`; add no new filesystem traversal.
- Call `park()` only after the complete unified decision and at most once per repository wrapper.
- Keep fork additions marked `PARA-PATCH`/`PARA-CODE` consistently and add no dependency.
- Edit files only with `apply_patch`; prefix every shell command with `rtk`.

---

### Task 1: Unify repository parking after current-folder checks

**Files:**
- Modify: `extensions/git/src/paradisUnaccountedToPark.ts`
- Modify: `extensions/git/src/test/paradisUnaccountedToPark.test.ts`
- Modify: `extensions/git/src/model.ts`

**Interfaces:**
- Consumes: `IParadisUnaccountedCandidate` and caller-supplied `isDescendant`.
- Produces: existing `selectUnaccountedForParking(...)`, plus `selectRepositoriesForUnifiedParking(removed, open, activeRepositories, currentFolderPaths, isDescendant)` used by `Model.onDidChangeWorkspaceFolders` before any `park()` mutation.

- [ ] **Step 1: Write the failing test**

Extend the selector tests with these regressions:

- A removed-folder candidate rooted at `/repo` stays open when the current folder is `/repo/packages/app`.
- A candidate whose `rootRealPath` is `/private/repo` stays open for logical/current aliases supplied as both `/tmp/repo/app` and `/private/repo/app`.
- A repository nested beneath the current folder remains open.
- The same repository candidate supplied by the removed-folder pass and the all-open pass appears at most once in the result.
- Two distinct unaccounted repositories are both returned in stable first-seen order.

Use the existing POSIX stand-in `isDescendant`, so the test remains runnable without the extension host.

```ts
const ancestor = candidate('/repo');
const unrelated = candidate('/other');
const active = candidate('/active');
const result = selectRepositoriesForUnifiedParking(
	[ancestor, active],
	[ancestor, active, unrelated],
	new Set([active.repository]),
	['/repo/packages/app'],
	isDescendant,
);
assert.deepStrictEqual(result, [unrelated]);

const aliased = candidate('/tmp/repo', '/private/repo');
assert.deepStrictEqual(
	selectUnaccountedForParking([aliased, aliased], ['/tmp/repo/app', '/private/repo/app'], isDescendant),
	[],
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run from `extensions/git`: `rtk npm test -- --ui tdd out/test/paradisUnaccountedToPark.test.js`

Before running, compile with `rtk npm run compile` so the new TypeScript assertions are present in `out`.

Expected: FAIL because `selectRepositoriesForUnifiedParking` does not exist; this is the seam that prevents the model's current premature first-pass mutation.

- [ ] **Step 3: Write minimal implementation**

Accept a deduplicated flat path list containing both logical and real current-folder paths, and keep the selector independent of `vscode`. For every candidate, compare `repository.root` and optional `rootRealPath` against every current path in both containment directions. Deduplicate candidates by repository object identity, preserving first-seen order. Do not add filesystem access to this pure module.

```ts
export function selectRepositoriesForUnifiedParking<T extends IParadisUnaccountedCandidate>(
	removed: readonly (T | undefined)[],
	open: readonly T[],
	activeRepositories: ReadonlySet<T['repository']>,
	currentFolderPaths: readonly string[],
	isDescendant: (parent: string, descendant: string) => boolean,
): T[] {
	const seen = new Set<T['repository']>();
	const candidates: T[] = [];
	for (const candidate of [...removed, ...open]) {
		if (!candidate || activeRepositories.has(candidate.repository) || seen.has(candidate.repository)) { continue; }
		seen.add(candidate.repository);
		candidates.push(candidate);
	}
	return selectUnaccountedForParking(candidates, currentFolderPaths, isDescendant);
}
```

Replace both existing parking passes in `Model.onDidChangeWorkspaceFolders` with one call after resolving current logical and real folder paths:

```ts
const activeRepositories = new Set(window.visibleTextEditors
	.map(editor => this.getRepository(editor.document.uri))
	.filter(repository => !!repository) as Repository[]);
const removedRepositories = removed.map(folder => this.getOpenRepository(folder.uri));
const currentFolders = (workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
const currentFolderPaths = new Set(currentFolders.map(folder => folder.uri.fsPath));
for (const realPath of await Promise.all(currentFolders.map(folder => this.getWorkspaceFolderRealPath(folder)))) {
	if (realPath) { currentFolderPaths.add(realPath); }
}
const repositoriesToPark = selectRepositoriesForUnifiedParking(
	removedRepositories,
	this.openRepositories,
	activeRepositories,
	[...currentFolderPaths],
	isDescendant,
);
repositoriesToPark.forEach(repository => repository.park());
```

Keep `unparkForFolder`, `possibleRepositoryFolders`, later `openRepository` calls, trust handling, and catch/log behavior unchanged. Update the surrounding `PARA-PATCH` comment to describe the single gather/decide/mutate pass.

- [ ] **Step 4: Run the test to verify it passes**

Run from `extensions/git`:

1. `rtk npm run compile`
2. `rtk npm test -- --ui tdd out/test/paradisUnaccountedToPark.test.js`
3. `rtk npm test -- --ui tdd out/test/paradisRepositoryPark.test.js`

Expected: compile reports zero errors and both suites pass.

- [ ] **Step 5: Commit**

```bash
rtk git add extensions/git/src/model.ts extensions/git/src/paradisUnaccountedToPark.ts extensions/git/src/test/paradisUnaccountedToPark.test.ts
rtk git commit -m "fix: decide repository parking after current-folder checks"
```
