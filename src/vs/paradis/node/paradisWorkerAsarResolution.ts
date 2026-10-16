/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// worker_threads の worker の中で、npm パッケージを `node_modules.asar` から解決できるようにする。
//
// パッケージ版の npm パッケージは `Resources/app/node_modules.asar` の中にだけあり、素の名前を asar へ
// 向けるのは `src/bootstrap-esm.ts` の `registerHooks` の仕事。このフックは登録したスレッドにしか効かず、
// worker へは引き継がれない。バンドルは `packages: 'external'` なので、worker の入口のバンドルにも
// npm パッケージは入らない。そのため worker の中では `yauzl` などが ERR_MODULE_NOT_FOUND になる
// （開発ビルドは `node_modules` があるので再現しない）。
//
// worker は `paradisWorkerBootstrap.ts` を入口にして起こし、そこでこのフックを登録してから本体を
// 動的に import する。解決の手順は、ESM は `src/bootstrap-esm.ts`、CommonJS（`yauzl` の中の
// `require('pend')` など）は `src/bootstrap-node.ts` の `enableASARSupport` と同じにしてある（upstream の
// ファイルはバンドルされて別の .js として残らず、process 向けの副作用もあるので import しない）。
// upstream がそちらを変えたら、ここも合わせること。

import { createRequire, isBuiltin, registerHooks, type Module } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { join } from '../../base/common/path.js';

/** worker の起動時に渡す `workerData` の中で、本体の入口（file: の URL）を入れる名前。 */
export const PARADIS_WORKER_ENTRY_KEY = 'paradisWorkerEntry';

/**
 * worker の入口の手順。asar の解決を登録してから本体を読む。順番が逆だと、本体の静的な import が
 * 登録の前に解決されて落ちる。
 */
export async function startParadisWorkerEntry(data: unknown, register: () => void, load: (url: string) => Promise<unknown>): Promise<void> {
	const entry = data && typeof data === 'object' ? (data as Record<string, unknown>)[PARADIS_WORKER_ENTRY_KEY] : undefined;
	if (typeof entry !== 'string' || !entry.startsWith('file:')) {
		throw new Error('Para Code worker started without an entry module');
	}
	register();
	await load(entry);
}

/**
 * このスレッドに asar の解決を登録する。Electron の上でだけ登録し、登録したら true を返す。
 * `appRoot` は `out` の 1 つ上（パッケージ版では `Resources/app`）。開発ビルド（`VSCODE_DEV`）では
 * `fs` を `original-fs` へ向けるだけで、asar は見ない（`bootstrap-esm.ts` と同じ）。
 */
export function registerParadisWorkerAsarResolution(appRoot: string, env: NodeJS.ProcessEnv = process.env, versions: NodeJS.ProcessVersions = process.versions): boolean {
	if (!env.ELECTRON_RUN_AS_NODE && !versions.electron) {
		return false;
	}

	// `bootstrap-esm.ts` は値がパスならファイルへ書くが、worker では同期の書き込みを避けて常に標準エラーへ出す。
	const trace = env.VSCODE_ASAR_TRACE
		? (message: string) => { try { process.stderr.write(`[asar-resolve:worker] ${message}\n`); } catch { /* ignore */ } }
		: undefined;

	const normalizeDriveLetter = (path: string): string => {
		if (
			process.platform === 'win32' &&
			path.length >= 2 &&
			(path.charCodeAt(0) >= 65 && path.charCodeAt(0) <= 90 || path.charCodeAt(0) >= 97 && path.charCodeAt(0) <= 122) &&
			path.charCodeAt(1) === 58
		) {
			return path[0].toLowerCase() + path.slice(1);
		}
		return path;
	};

	const isBarePackageSpecifier = (specifier: string): boolean => {
		if (specifier === '') { return false; }
		const c = specifier[0];
		if (c === '.' || c === '/' || c === '#') { return false; }
		return !URL.canParse(specifier);
	};

	const packageNameOf = (specifier: string): string => {
		if (specifier[0] === '@') {
			const firstSlash = specifier.indexOf('/');
			if (firstSlash === -1) { return specifier; }
			const secondSlash = specifier.indexOf('/', firstSlash + 1);
			return secondSlash === -1 ? specifier : specifier.slice(0, secondSlash);
		}
		const slash = specifier.indexOf('/');
		return slash === -1 ? specifier : specifier.slice(0, slash);
	};

	const resolutionCache = new Map<string, Module.ResolveFnOutput>();
	const resolutionCacheKey = (specifier: string, parentPath: string, context: Module.ResolveHookContext): string => {
		const importAttributes = Object.entries(context.importAttributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
		return JSON.stringify([specifier, parentPath, context.conditions, importAttributes]);
	};

	const resourcesPath = env.VSCODE_DEV ? undefined : normalizeDriveLetter(appRoot);
	if (resourcesPath) {
		addArchiveToCommonJSLookup(join(appRoot, 'node_modules'), normalizeDriveLetter);
	}
	const asarRequire = resourcesPath ? createRequire(join(appRoot, 'node_modules.asar', 'x.js')) : undefined;
	trace?.(`tracing enabled (node ${process.versions.node}); resourcesPath=${resourcesPath}`);

	let commonJSConditions: readonly string[] | undefined;
	let captureCommonJSConditions = true;

	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (captureCommonJSConditions) {
				captureCommonJSConditions = false;
				commonJSConditions = [...context.conditions];
				return nextResolve(specifier, context);
			}

			const cjsConditions = commonJSConditions;
			const isCommonJS = context.importAttributes === undefined || (
				cjsConditions !== undefined &&
				context.conditions.length === cjsConditions.length &&
				context.conditions.every((condition, index) => condition === cjsConditions[index])
			);
			if (isCommonJS) {
				return nextResolve(specifier, context);
			}
			if (specifier === 'fs') {
				return { format: 'builtin', shortCircuit: true, url: 'node:original-fs' };
			}

			if (asarRequire && resourcesPath && context.parentURL && isBarePackageSpecifier(specifier) && !isBuiltin(specifier) && specifier !== 'electron' && !specifier.startsWith('electron/')) {
				let parentPath: string | undefined;
				try { parentPath = normalizeDriveLetter(fileURLToPath(context.parentURL)); } catch { parentPath = undefined; }
				if (parentPath && parentPath.startsWith(resourcesPath)) {
					trace?.(`resolve "${specifier}" from "${context.parentURL}"`);
					const cacheKey = resolutionCacheKey(specifier, parentPath, context);
					const cached = resolutionCache.get(cacheKey);
					if (cached) {
						return cached;
					}

					let defaultResult;
					let defaultError: Error | undefined;
					try {
						defaultResult = nextResolve(specifier, context);
					} catch (error) {
						defaultError = error instanceof Error ? error : new Error(String(error));
					}

					if (defaultResult) {
						let resolvedPath: string | undefined;
						try { resolvedPath = normalizeDriveLetter(fileURLToPath(defaultResult.url)); } catch { resolvedPath = undefined; }
						if (!resolvedPath || resolvedPath.startsWith(resourcesPath)) {
							trace?.(`  default -> ${defaultResult.url} (in app, ACCEPT)`);
							return defaultResult;
						}
						trace?.(`  default -> ${defaultResult.url} (outside app, reject)`);
					}

					let packageJsonPath: string;
					try {
						packageJsonPath = asarRequire.resolve(`./${packageNameOf(specifier)}/package.json`);
					} catch {
						trace?.(`  archive: package "${packageNameOf(specifier)}" NOT in archive -> throw`);
						throw defaultError ?? new Error(`Cannot find package '${specifier}' within the application resources`);
					}

					try {
						const selfRef = nextResolve(specifier, { ...context, parentURL: pathToFileURL(packageJsonPath).href });
						let selfRefPath: string | undefined;
						try { selfRefPath = normalizeDriveLetter(fileURLToPath(selfRef.url)); } catch { selfRefPath = undefined; }
						if (selfRefPath && selfRefPath.startsWith(resourcesPath)) {
							trace?.(`  self-ref -> ${selfRef.url} (in app, ACCEPT)`);
							resolutionCache.set(cacheKey, { ...selfRef, shortCircuit: true });
							return selfRef;
						}
						trace?.(`  self-ref -> ${selfRef.url} (escaped app, reject)`);
					} catch (error) {
						trace?.(`  self-ref -> <throw> (${error instanceof Error ? error.message : String(error)})`);
					}
					const resolved = asarRequire.resolve(`./${specifier}`);
					const result = { url: pathToFileURL(resolved).href, shortCircuit: true };
					trace?.(`  direct -> ${result.url} (ACCEPT)`);
					resolutionCache.set(cacheKey, result);
					return result;
				}
			}

			return nextResolve(specifier, context);
		}
	});

	try {
		createRequire(import.meta.url).resolve('node:fs');
	} finally {
		captureCommonJSConditions = false;
	}
	if (!commonJSConditions) {
		throw new Error('Failed to identify CommonJS module resolution conditions');
	}
	return true;
}

/**
 * CommonJS の `require` の探し先で、`<appRoot>/node_modules` の直前に `node_modules.asar` を入れる
 * （`bootstrap-node.ts` の `enableASARSupport` と同じ）。asar の中のパッケージが、同じ asar の中の
 * 別のパッケージを `require` できるようにするため。
 */
function addArchiveToCommonJSLookup(nodeModulesPath: string, normalizeDriveLetter: (path: string) => string): void {
	const target = normalizeDriveLetter(nodeModulesPath);
	const Module = createRequire(import.meta.url)('module') as { _resolveLookupPaths: (request: string, parent: unknown) => string[] | null };
	const originalResolveLookupPaths = Module._resolveLookupPaths;
	Module._resolveLookupPaths = function (request: string, parent: unknown): string[] | null {
		const paths = originalResolveLookupPaths(request, parent);
		if (Array.isArray(paths)) {
			for (let i = 0, len = paths.length; i < len; i++) {
				if (normalizeDriveLetter(paths[i]) === target) {
					paths.splice(i, 0, `${paths[i]}.asar`);
					break;
				}
			}
		}
		return paths;
	};
}
