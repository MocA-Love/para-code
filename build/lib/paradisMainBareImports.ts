/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// The packaged main process bundle (out/mainImpl.js) keeps npm packages external, and its static
// imports are resolved by Node's plain resolver while the module links, before bootstrap-esm.ts
// installs the node_modules.asar hook. A static import of an npm package there therefore stops the
// app before any code runs (ERR_MODULE_NOT_FOUND, paracode-68). npm packages must be imported
// dynamically from main. This lists the bare static imports the bundle would keep, for every entry
// point the desktop app bundles that way.

import { builtinModules } from 'module';
import * as path from 'path';
import esbuild from 'esbuild';
import { getBootstrapEntryPointsForTarget } from './esbuild.ts';

/** Bare specifiers the packaged main may import statically. */
const ALLOWED_MAIN_BARE_IMPORTS = new Set(['electron', 'original-fs', 'minimist']);

function isAllowed(specifier: string): boolean {
	const name = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
	return ALLOWED_MAIN_BARE_IMPORTS.has(specifier) || builtinModules.includes(name) || builtinModules.includes(name.split('/')[0]);
}

/**
 * Desktop entry points bundled with npm packages left external (main, mainImpl, cli, bootstrap-fork).
 * The server entries are bundled the same way, but the server ships a plain node_modules folder (no
 * asar), so their static npm imports resolve at link time; upstream's server-main imports cookie and
 * yauzl statically. Only the desktop entries run inside the asar-packed app.
 */
export function paradisExternalPackageEntryPoints(): string[] {
	return getBootstrapEntryPointsForTarget('desktop');
}

/** Bundles src/<entry>.ts the way the packaged build does and returns its static bare imports. */
export async function listParadisBareImports(repoRoot: string, entry: string): Promise<string[]> {
	const result = await esbuild.build({
		entryPoints: [path.join(repoRoot, 'src', `${entry}.ts`)],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: ['es2024'],
		packages: 'external',
		write: false,
		logLevel: 'error',
		plugins: [
			{ name: 'css', setup(build) { build.onResolve({ filter: /\.css$/ }, args => ({ path: args.path, external: true })); } },
			// main.ts loads mainImpl.js at run time; the packaged build keeps it a separate file
			{ name: 'main-impl-external', setup(build) { build.onResolve({ filter: /^\.\/mainImpl\.js$/ }, args => ({ path: args.path, external: true })); } },
		],
		tsconfigRaw: JSON.stringify({ compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } }),
	});
	const code = result.outputFiles[0].text;
	const specifiers = [...code.matchAll(/^import\s[^;]*?from\s*"(?<specifier>[^".][^"]*)"/gm), ...code.matchAll(/^import\s*"(?<specifier>[^".][^"]*)"/gm)]
		.map(match => match.groups?.specifier ?? '');
	return [...new Set(specifiers)].sort();
}

/** For each entry point, the static bare imports that would stop the app at startup. */
export async function findParadisForbiddenBareImports(repoRoot: string): Promise<Record<string, string[]>> {
	const forbidden: Record<string, string[]> = {};
	for (const entry of paradisExternalPackageEntryPoints()) {
		const found = (await listParadisBareImports(repoRoot, entry)).filter(specifier => !isAllowed(specifier));
		if (found.length > 0) {
			forbidden[entry] = found;
		}
	}
	return forbidden;
}

if (import.meta.main) {
	const forbidden = await findParadisForbiddenBareImports(path.join(import.meta.dirname, '..', '..'));
	if (Object.keys(forbidden).length > 0) {
		for (const [entry, specifiers] of Object.entries(forbidden)) {
			console.error(`${entry}: statically imports npm packages: ${specifiers.join(', ')}. Import them dynamically.`);
		}
		process.exit(1);
	}
	console.log(`${paradisExternalPackageEntryPoints().join(', ')}: static imports are only Node built-ins and allowed packages.`);
}
