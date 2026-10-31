/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * `files.watcherExclude` keys that Para Code adds to the defaults.
 *
 * The node_modules key must stay exactly `**\/node_modules/*\/**`: the TypeScript extension
 * checks for this exact key and then falls back to tsserver's own file watching instead of
 * the VS Code watcher (which would otherwise miss package changes under the exclude).
 */
export const PARADIS_NODE_MODULES_WATCHER_EXCLUDE = '**/node_modules/*/**';
export const PARADIS_VENV_WATCHER_EXCLUDE = '**/.venv/**';

/**
 * Root-relative forms handed to `@parcel/watcher` instead of the keys above. A leading `**\/`
 * turns into a regex with nested lookaheads that `std::regex` evaluates for every watched path
 * (upstream microsoft/vscode#305923, which is why upstream dropped `**\/` from its defaults).
 * Root-relative forms fail at the first character for unrelated paths. They cover the folder
 * itself and two levels of nesting (monorepo packages); deeper matches are still dropped by the
 * JS-side exclude, which keeps using the original key.
 */
const PARCEL_REWRITES = new Map<string, readonly string[]>([
	[PARADIS_NODE_MODULES_WATCHER_EXCLUDE, ['node_modules/*/**', '*/node_modules/*/**', '*/*/node_modules/*/**']],
	[PARADIS_VENV_WATCHER_EXCLUDE, ['.venv/**', '*/.venv/**', '*/*/.venv/**']],
]);

/**
 * Returns the excludes to pass to `@parcel/watcher`. Only the exact Para Code default keys are
 * rewritten; every other pattern is passed through unchanged. The input array is not modified.
 */
export function paradisRewriteParcelExcludes(excludes: readonly string[]): string[] {
	const result: string[] = [];
	for (const exclude of excludes) {
		for (const pattern of PARCEL_REWRITES.get(exclude) ?? [exclude]) {
			if (!result.includes(pattern)) {
				result.push(pattern);
			}
		}
	}

	return result;
}
