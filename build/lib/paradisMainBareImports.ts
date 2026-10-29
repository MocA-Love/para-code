/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The packaged main process bundle (out/mainImpl.js) keeps npm packages external, and its static
// imports are resolved by Node's plain resolver while the module links, before bootstrap-esm.ts
// installs the node_modules.asar hook. A static import of an npm package there therefore stops the
// app before any code runs (ERR_MODULE_NOT_FOUND, paracode-68). npm packages must be imported
// dynamically from main. This lists the bare static imports the bundle would keep.

import { builtinModules } from 'module';
import * as path from 'path';
import esbuild from 'esbuild';

/** Bare specifiers the packaged main may import statically. */
const ALLOWED_MAIN_BARE_IMPORTS = new Set(['electron', 'original-fs', 'minimist']);

function isAllowed(specifier: string): boolean {
	const name = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
	return ALLOWED_MAIN_BARE_IMPORTS.has(specifier) || builtinModules.includes(name) || builtinModules.includes(name.split('/')[0]);
}

/** Bundles src/mainImpl.ts the way the packaged build does and returns its static bare imports. */
export async function listParadisMainBareImports(repoRoot: string): Promise<string[]> {
	const result = await esbuild.build({
		entryPoints: [path.join(repoRoot, 'src', 'mainImpl.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: ['es2024'],
		packages: 'external',
		write: false,
		logLevel: 'error',
		plugins: [{ name: 'css', setup(build) { build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, external: true })); } }],
		tsconfigRaw: JSON.stringify({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }),
	});
	const code = result.outputFiles[0].text;
	const specifiers = [...code.matchAll(/^import\s[^;]*?from\s*"(?<specifier>[^".][^"]*)"/gm), ...code.matchAll(/^import\s*"(?<specifier>[^".][^"]*)"/gm)]
		.map(match => match.groups?.specifier ?? '');
	return [...new Set(specifiers)].sort();
}

/** The static bare imports of the packaged main that would stop the app at startup. */
export async function findParadisForbiddenMainImports(repoRoot: string): Promise<string[]> {
	return (await listParadisMainBareImports(repoRoot)).filter(specifier => !isAllowed(specifier));
}

if (import.meta.main) {
	const forbidden = await findParadisForbiddenMainImports(path.join(import.meta.dirname, '..', '..'));
	if (forbidden.length > 0) {
		console.error(`The main process bundle statically imports npm packages: ${forbidden.join(', ')}. Import them dynamically.`);
		process.exit(1);
	}
	console.log('The main process bundle statically imports only Node built-ins and allowed packages.');
}
