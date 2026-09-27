/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from 'esbuild';
// PARA-PATCH: used to verify the pinned docx-preview 0.3.7 vendor build (buildDocxPreview037).
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
// PARA-PATCH: used to unpack the docx-preview 0.3.7 tarball (buildDocxPreview037).
import { gunzipSync } from 'zlib';
// PARA-PATCH: used by the @sentry inlining rule in inlineParadisSentryPlugin below.
import { fileURLToPath } from 'url';

import glob from 'glob';
import gulpWatch from '../lib/watch/index.ts';
import { nlsPlugin, createNLSCollector, finalizeNLS, postProcessNLS } from './nls-plugin.ts';
import { convertPrivateFields, adjustSourceMap, type ConvertPrivateFieldsResult } from './private-to-property.ts';
import { rewriteSourceMappingURL } from './source-map-url.ts';
import { getVersion } from '../lib/getVersion.ts';
import { getGitCommitDate } from '../lib/date.ts';
import { getBootstrapEntryPointsForTarget, type BuildTarget } from '../lib/esbuild.ts';
import product from '../../product.json' with { type: 'json' };
import packageJson from '../../package.json' with { type: 'json' };
import { isWebExtension, type IScannedBuiltinExtension } from '../lib/extensions.ts';
import { runBuildFast } from './build-fast.ts';
import { bundleDevTunnelsWeb, devTunnelsWebOutDir } from './devTunnelsWeb.ts';
import { copyFile, mapWithConcurrency, MAX_CONCURRENT_FILE_OPERATIONS, transpileFile } from './transpile.ts';
import { copyResources } from './resources.ts';
import { optimizeSvgFiles } from './svg.ts';
import { getBundleOptions } from './bundle.ts';
import { compileStandaloneFiles } from './standalone.ts';

const globAsync = promisify(glob);

// ============================================================================
// Configuration
// ============================================================================

const REPO_ROOT = path.dirname(path.dirname(import.meta.dirname));
const commit = getVersion(REPO_ROOT);
const quality = (product as { quality?: string }).quality;
const version = (quality && quality !== 'stable') ? `${packageJson.version}-${quality}` : packageJson.version;

// PARA-PATCH: document the fork-only docx-preview-037 command.
// CLI: build-fast [--force] | transpile [--watch] | bundle [--minify] [--nls] [--out <dir>] | docx-preview-037 [--check] [--out <dir>]
const command = process.argv[2];

function getArgValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index !== -1 && index + 1 < process.argv.length) {
		return process.argv[index + 1];
	}
	return undefined;
}

const options = {
	watch: process.argv.includes('--watch'),
	minify: process.argv.includes('--minify'),
	nls: process.argv.includes('--nls'),
	manglePrivates: process.argv.includes('--mangle-privates'),
	excludeTests: process.argv.includes('--exclude-tests'),
	force: process.argv.includes('--force'),
	// PARA-PATCH: --check option of the fork-only docx-preview-037 command.
	check: process.argv.includes('--check'),
	out: getArgValue('--out'),
	target: getArgValue('--target') ?? 'desktop', // 'desktop' | 'server' | 'server-web' | 'web'
	sourceMapBaseUrl: getArgValue('--source-map-base-url'),
};

const SRC_DIR = 'src';
const OUT_DIR = 'out';
const OUT_VSCODE_DIR = 'out-vscode';

// ============================================================================
// Entry Points
// ============================================================================

// Extension host bundles are excluded from private field mangling because they
// expose API surface to extensions where encapsulation matters.
const extensionHostEntryPoints = [
	'vs/workbench/api/node/extensionHostProcess',
	'vs/workbench/api/worker/extensionHostWorkerMain',
];

function isExtensionHostBundle(filePath: string): boolean {
	const normalized = filePath.replaceAll('\\', '/');
	return extensionHostEntryPoints.some(ep => normalized.endsWith(`${ep}.js`));
}

// Workers - shared between targets
const workerEntryPoints = [
	'vs/editor/common/services/editorWebWorkerMain',
	'vs/workbench/api/worker/extensionHostWorkerMain',
	'vs/workbench/contrib/notebook/common/services/notebookWebWorkerMain',
	'vs/workbench/services/languageDetection/browser/languageDetectionWebWorkerMain',
	'vs/workbench/services/search/worker/localFileSearchMain',
	'vs/workbench/contrib/output/common/outputLinkComputerMain',
	'vs/workbench/services/textMate/browser/backgroundTokenization/worker/textMateTokenizationWorker.workerMain',
];

// Desktop-only workers (use electron-browser)
const desktopWorkerEntryPoints = [
	'vs/platform/profiling/electron-browser/profileAnalysisWorkerMain',
];

// Desktop workbench and code entry points
const desktopEntryPoints = [
	'vs/workbench/workbench.desktop.main',
	'vs/sessions/sessions.desktop.main',
	'vs/workbench/contrib/debug/node/telemetryApp',
	'vs/platform/files/node/watcher/watcherMain',
	'vs/platform/localTranscription/node/localTranscriptionMain',
	'vs/platform/terminal/node/ptyHostMain',
	// PARA-PATCH: pipes a window's message port to the pty daemon that outlives the app
	'vs/paradis/contrib/ptyDaemon/node/paradisPtyDaemonBridgeMain',
	// PARA-PATCH: entry point ptyHostMain spawns as the reconnect-across-updates pty
	// daemon (paradisEnsurePtyHost). Nothing imports it, so it only reaches a packaged
	// build by being listed here.
	'vs/paradis/contrib/ptyDaemon/node/paradisPtyHostDaemonEntry',
	'vs/platform/agentHost/node/agentHostMain',
	'vs/platform/agentHost/node/diffWorkerMain',
	'vs/workbench/api/node/extensionHostProcess',
	// PARA-PATCH: ship the Para Code agent-browser MCP stdio shim. Agent CLIs (Claude Code / Codex)
	// run it directly via `node out/vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim.js`
	// (see paradisMcpSnippets.ts), so packaged builds must emit it at that exact path.
	'vs/paradis/contrib/agentBrowser/node/paradisBrowserMcpShim',
	// PARA-PATCH: worker thread the shared process starts to read agent transcripts (usage per space, full-text index)
	'vs/paradis/contrib/agentActivity/node/paradisAgentActivityWorkerMain',
];

const codeEntryPoints = [
	'vs/code/node/cliProcessMain',
	'vs/code/electron-utility/sharedProcess/sharedProcessMain',
	'vs/code/electron-browser/workbench/workbench',
	'vs/sessions/electron-browser/sessions',
];

// Additional web-only entry points (CDN build only, not in server-web)
const sessionsWebEntryPoint = 'vs/sessions/sessions.web.main.internal';
const webOnlyEntryPoints = [
	sessionsWebEntryPoint,
];

const keyboardMapEntryPoints = [
	'vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.linux',
	'vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.darwin',
	'vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.win',
];

// Server entry points (reh)
const serverEntryPoints = [
	'vs/workbench/api/node/extensionHostProcess',
	'vs/platform/files/node/watcher/watcherMain',
	'vs/platform/terminal/node/ptyHostMain',
	// PARA-PATCH: entry point ptyHostMain spawns as the reconnect-across-updates pty
	// daemon (paradisEnsurePtyHost). Nothing imports it, so it only reaches a packaged
	// build by being listed here.
	'vs/paradis/contrib/ptyDaemon/node/paradisPtyHostDaemonEntry',
	'vs/platform/agentHost/node/agentHostMain',
	'vs/platform/agentHost/node/diffWorkerMain',
];

/**
 * Get entry points for a build target.
 */
function getEntryPointsForTarget(target: BuildTarget): string[] {
	switch (target) {
		case 'desktop':
			return [
				...workerEntryPoints,
				...desktopWorkerEntryPoints,
				...desktopEntryPoints,
				...codeEntryPoints,
			];
		case 'server':
			return [
				...serverEntryPoints,
			];
		case 'server-web':
			return [
				...serverEntryPoints,
				...workerEntryPoints,
				'vs/code/browser/workbench/workbench', // Includes workbench.web.main.internal.
				...keyboardMapEntryPoints,
			];
		case 'web':
			return [
				...workerEntryPoints,
				...webOnlyEntryPoints,
				'vs/workbench/workbench.web.main.internal', // web workbench only (no browser shell)
				...keyboardMapEntryPoints,
			];
		default:
			throw new Error(`Unknown target: ${target}`);
	}
}

/**
 * Get entry points that should bundle CSS (workbench mains).
 */
function getCssBundleEntryPointsForTarget(target: BuildTarget): Set<string> {
	switch (target) {
		case 'desktop':
			return new Set([
				'vs/workbench/workbench.desktop.main',
				'vs/code/electron-browser/workbench/workbench',
				'vs/sessions/sessions.desktop.main',
				'vs/sessions/electron-browser/sessions',
			]);
		case 'server':
			return new Set(); // Server has no UI
		case 'server-web':
			return new Set([
				'vs/code/browser/workbench/workbench',
			]);
		case 'web':
			return new Set([
				'vs/workbench/workbench.web.main.internal',
				'vs/sessions/sessions.web.main.internal',
			]);
		default:
			throw new Error(`Unknown target: ${target}`);
	}
}

// ============================================================================
// Utilities
// ============================================================================

async function cleanDir(dir: string): Promise<void> {
	const fullPath = path.join(REPO_ROOT, dir);
	console.log(`[clean] ${dir}`);
	await fs.promises.rm(fullPath, { recursive: true, force: true });
	await fs.promises.mkdir(fullPath, { recursive: true });
}

/**
 * Scan for built-in extensions in the given directory.
 * Returns an array of extension entries for the builtinExtensionsScannerService.
 */
function scanBuiltinExtensions(extensionsRoot: string): Array<IScannedBuiltinExtension> {
	const scannedExtensions: Array<IScannedBuiltinExtension> = [];
	const extensionsPath = path.join(REPO_ROOT, extensionsRoot);

	if (!fs.existsSync(extensionsPath)) {
		return scannedExtensions;
	}

	for (const extensionFolder of fs.readdirSync(extensionsPath)) {
		const packageJSONPath = path.join(extensionsPath, extensionFolder, 'package.json');
		if (!fs.existsSync(packageJSONPath)) {
			continue;
		}
		try {
			const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath, 'utf8'));
			if (!isWebExtension(packageJSON)) {
				continue;
			}
			const children = fs.readdirSync(path.join(extensionsPath, extensionFolder));
			const packageNLSPath = children.filter(child => child === 'package.nls.json')[0];
			const packageNLS = packageNLSPath ? JSON.parse(fs.readFileSync(path.join(extensionsPath, extensionFolder, packageNLSPath), 'utf8')) : undefined;
			const readme = children.filter(child => /^readme(\.txt|\.md|)$/i.test(child))[0];
			const changelog = children.filter(child => /^changelog(\.txt|\.md|)$/i.test(child))[0];

			scannedExtensions.push({
				extensionPath: extensionFolder,
				packageJSON,
				packageNLS,
				readmePath: readme ? path.join(extensionFolder, readme) : undefined,
				changelogPath: changelog ? path.join(extensionFolder, changelog) : undefined,
			});
		} catch (e) {
			// Skip invalid extensions
		}
	}

	return scannedExtensions;
}

/**
 * Get the date from the out directory date file, or return the git commit date.
 */
function readISODate(outDir: string): string {
	try {
		return fs.readFileSync(path.join(REPO_ROOT, outDir, 'date'), 'utf8');
	} catch {
		return getGitCommitDate();
	}
}

/**
 * Copy ALL non-TypeScript files from src/ to the output directory.
 * This matches the old gulp build behavior where `gulp.src('src/**')` streams
 * every file and non-TS files bypass the compiler via tsFilter.restore.
 * Used for development/transpile builds only - production bundles use
 * copyResources() with curated per-target patterns instead.
 */
async function copyAllNonTsFiles(outDir: string, excludeTests: boolean): Promise<void> {
	console.log(`[resources] Copying all non-TS files to ${outDir}...`);

	const ignorePatterns = [
		// Exclude .ts files but keep .d.ts files (they're needed at runtime for type references)
		'**/*.ts',
	];
	if (excludeTests) {
		ignorePatterns.push('**/test/**');
	}

	const files = await globAsync('**/*', {
		cwd: path.join(REPO_ROOT, SRC_DIR),
		nodir: true,
		ignore: ignorePatterns,
	});

	// Re-include .d.ts files that were excluded by the *.ts ignore
	const dtsFiles = await globAsync('**/*.d.ts', {
		cwd: path.join(REPO_ROOT, SRC_DIR),
		ignore: excludeTests ? ['**/test/**'] : [],
	});

	const allFiles = [...new Set([...files, ...dtsFiles])];

	await mapWithConcurrency(allFiles, MAX_CONCURRENT_FILE_OPERATIONS, file => {
		const srcPath = path.join(REPO_ROOT, SRC_DIR, file);
		const destPath = path.join(REPO_ROOT, outDir, file);
		return copyFile(srcPath, destPath);
	});

	console.log(`[resources] Copied ${allFiles.length} files`);
}

// ============================================================================
// Plugins
// ============================================================================

function inlineMinimistPlugin(): esbuild.Plugin {
	return {
		name: 'inline-minimist',
		setup(build) {
			build.onResolve({ filter: /^minimist$/ }, () => ({
				path: path.join(REPO_ROOT, 'node_modules/minimist/index.js'),
				external: false,
			}));
		},
	};
}

// PARA-PATCH: '@sentry/electron/renderer' is statically imported by the workbench bundle,
// but packaged renderer windows load over vscode-file:// where a bare specifier can never
// resolve (no Node resolver and no importmap for npm packages) — so statically imported
// @sentry modules are inlined into the importing bundle. Dynamic @sentry imports (main and
// shared/utility processes) stay external and resolve from node_modules.asar at runtime
// via the bootstrap loader hooks.
function inlineParadisSentryPlugin(): esbuild.Plugin {
	return {
		name: 'inline-paradis-sentry',
		setup(build) {
			build.onResolve({ filter: /^@sentry(-internal)?\// }, (args) => {
				if (args.kind === 'dynamic-import') {
					return { path: args.path, external: true };
				}
				return { path: fileURLToPath(import.meta.resolve(args.path)), external: false };
			});
		},
	};
}

function cssExternalPlugin(): esbuild.Plugin {
	// Mark CSS imports as external so they stay as import statements
	// The CSS files are copied separately and loaded by the browser at runtime
	return {
		name: 'css-external',
		setup(build) {
			build.onResolve({ filter: /\.css$/ }, (args) => ({
				path: args.path,
				external: true,
			}));
		},
	};
}

/**
 * esbuild plugin that transforms source files to inject build-time configuration.
 * This runs during onLoad so the transformation happens before esbuild processes the content,
 * ensuring placeholders like `/*BUILD->INSERT_PRODUCT_CONFIGURATION* /` are replaced
 * before esbuild strips them as non-legal comments.
 */
function fileContentMapperPlugin(outDir: string, target: BuildTarget): esbuild.Plugin {
	// Cache the replacement strings (computed once)
	let productConfigReplacement: string | undefined;
	let builtinExtensionsReplacement: string | undefined;

	return {
		name: 'file-content-mapper',
		setup(build) {
			build.onLoad({ filter: /\.ts$/ }, async (args) => {
				// Skip .d.ts files
				if (args.path.endsWith('.d.ts')) {
					return undefined;
				}

				let contents = await fs.promises.readFile(args.path, 'utf-8');
				let modified = false;

				// Inject product configuration
				if (contents.includes('/*BUILD->INSERT_PRODUCT_CONFIGURATION*/')) {
					if (productConfigReplacement === undefined) {
						// For server-web, remove webEndpointUrlTemplate
						const productForTarget = target === 'server-web'
							? { ...product, webEndpointUrlTemplate: undefined }
							: product;
						const productConfiguration = JSON.stringify({
							...productForTarget,
							version,
							commit,
							date: readISODate(outDir)
						});
						// Remove the outer braces since the placeholder is inside an object literal
						productConfigReplacement = productConfiguration.substring(1, productConfiguration.length - 1);
					}
					contents = contents.replace('/*BUILD->INSERT_PRODUCT_CONFIGURATION*/', () => productConfigReplacement!);
					modified = true;
				}

				// Inject built-in extensions list
				if (contents.includes('/*BUILD->INSERT_BUILTIN_EXTENSIONS*/')) {
					if (builtinExtensionsReplacement === undefined) {
						if (target === 'web' || target === 'server-web') {
							// Web target uses .build/web/extensions (from compileWebExtensionsBuildTask)
							// while server-web uses .build/extensions.
							const extensionsRoot = target === 'web' ? '.build/web/extensions' : '.build/extensions';
							const builtinExtensions = JSON.stringify(scanBuiltinExtensions(extensionsRoot));
							// Remove the outer brackets since the placeholder is inside an array literal
							builtinExtensionsReplacement = builtinExtensions.substring(1, builtinExtensions.length - 1);
						} else {
							// Native targets never consume the web-only bundled extension list.
							builtinExtensionsReplacement = '';
						}
					}
					contents = contents.replace('/*BUILD->INSERT_BUILTIN_EXTENSIONS*/', () => builtinExtensionsReplacement!);
					modified = true;
				}

				if (modified) {
					return { contents, loader: 'ts' };
				}

				// No modifications, let esbuild handle normally
				return undefined;
			});
		},
	};
}

// ============================================================================
// Transpile (Goal 1: TS → JS using esbuild.transform for maximum speed)
// ============================================================================

async function transpile(outDir: string, excludeTests: boolean): Promise<void> {
	// Find all .ts files
	const ignorePatterns = ['**/*.d.ts'];
	if (excludeTests) {
		ignorePatterns.push('**/test/**');
	}

	const files = await globAsync('**/*.ts', {
		cwd: path.join(REPO_ROOT, SRC_DIR),
		ignore: ignorePatterns,
	});

	console.log(`[transpile] Found ${files.length} files`);

	await mapWithConcurrency(files, MAX_CONCURRENT_FILE_OPERATIONS, file => {
		const srcPath = path.join(REPO_ROOT, SRC_DIR, file);
		const destPath = path.join(REPO_ROOT, outDir, file.replace(/\.ts$/, '.js'));
		return transpileFile(srcPath, destPath);
	});
}

// ============================================================================
// Bundle (Goal 2: JS → bundled JS)
// ============================================================================

async function bundle(outDir: string, doMinify: boolean, doNls: boolean, doManglePrivates: boolean, target: BuildTarget, sourceMapBaseUrl?: string): Promise<void> {
	await cleanDir(outDir);

	// Write build date file (used by packaging to embed in product.json).
	// Reuse the date from out-build/date if it exists (written by the gulp
	// writeISODate task) so that all parallel bundle outputs share the same
	// timestamp - this is required for deterministic builds (e.g. macOS Universal).
	const outDirPath = path.join(REPO_ROOT, outDir);
	await fs.promises.mkdir(outDirPath, { recursive: true });
	let buildDate: string;
	try {
		buildDate = await fs.promises.readFile(path.join(REPO_ROOT, 'out-build', 'date'), 'utf8');
	} catch {
		buildDate = getGitCommitDate();
	}
	await fs.promises.writeFile(path.join(outDirPath, 'date'), buildDate, 'utf8');

	console.log(`[bundle] ${SRC_DIR} → ${outDir} (target: ${target})${doMinify ? ' (minify)' : ''}${doNls ? ' (nls)' : ''}${doManglePrivates ? ' (mangle-privates)' : ''}`);
	const t1 = Date.now();

	// Create shared NLS collector (only used if doNls is true)
	const nlsCollector = createNLSCollector();
	const preserveEnglish = false; // Production mode: replace messages with null

	// Get entry points based on target
	const allEntryPoints = getEntryPointsForTarget(target);
	const bootstrapEntryPoints = getBootstrapEntryPointsForTarget(target);
	const bundleCssEntryPoints = getCssBundleEntryPointsForTarget(target);

	// Collect all build results (with write: false)
	const buildResults: { outPath: string; result: esbuild.BuildResult }[] = [];

	// Create the file content mapper plugin (injects product config, builtin extensions)
	const contentMapperPlugin = fileContentMapperPlugin(outDir, target);

	// Bundle each entry point directly from TypeScript source
	await Promise.all(allEntryPoints.map(async (entryPoint) => {
		const entryPath = path.join(REPO_ROOT, SRC_DIR, `${entryPoint}.ts`);
		const outPath = path.join(REPO_ROOT, outDir, `${entryPoint}.js`);

		// Use CSS external plugin for entry points that don't need bundled CSS
		const plugins: esbuild.Plugin[] = bundleCssEntryPoints.has(entryPoint) ? [] : [cssExternalPlugin()];
		// Add content mapper plugin to inject product config and builtin extensions
		plugins.push(contentMapperPlugin);
		// PARA-PATCH: inline statically imported @sentry modules (see inlineParadisSentryPlugin).
		plugins.push(inlineParadisSentryPlugin());
		if (doNls) {
			plugins.unshift(nlsPlugin({
				baseDir: path.join(REPO_ROOT, SRC_DIR),
				collector: nlsCollector,
			}));
		}

		// For entry points that bundle CSS, we need to use outdir instead of outfile
		// because esbuild can't produce multiple output files (JS + CSS) with outfile
		const needsCssBundling = bundleCssEntryPoints.has(entryPoint);

		const buildOptions: esbuild.BuildOptions = {
			...getBundleOptions(doMinify, 'neutral'),
			entryPoints: needsCssBundling
				? [{ in: entryPath, out: entryPoint }]
				: [entryPath],
			...(needsCssBundling
				? { outdir: path.join(REPO_ROOT, outDir) }
				: { outfile: outPath }),
			loader: {
				'.ttf': 'file',
				'.svg': 'file',
				'.png': 'file',
				'.sh': 'file',
			},
			assetNames: 'media/[name]',
			plugins,
		};

		const result = await esbuild.build(buildOptions);

		buildResults.push({ outPath, result });
	}));

	// Bundle bootstrap files (with minimist inlined) directly from TypeScript source
	for (const entry of bootstrapEntryPoints) {
		const entryPath = path.join(REPO_ROOT, SRC_DIR, `${entry}.ts`);
		const outPath = path.join(REPO_ROOT, outDir, `${entry}.js`);

		const bootstrapPlugins: esbuild.Plugin[] = [inlineMinimistPlugin(), contentMapperPlugin];
		if (doNls) {
			bootstrapPlugins.unshift(nlsPlugin({
				baseDir: path.join(REPO_ROOT, SRC_DIR),
				collector: nlsCollector,
			}));
		}

		const result = await esbuild.build({
			...getBundleOptions(doMinify, 'node'),
			entryPoints: [entryPath],
			outfile: outPath,
			plugins: bootstrapPlugins,
		});

		buildResults.push({ outPath, result });
	}

	// Finalize NLS: sort entries, assign indices, write metadata files
	let indexMap = new Map<string, number>();
	if (doNls) {
		// Also write NLS files to out-build for backwards compatibility with test runner
		const nlsResult = await finalizeNLS(
			nlsCollector,
			path.join(REPO_ROOT, outDir),
			[path.join(REPO_ROOT, 'out-build')]
		);
		indexMap = nlsResult.indexMap;
	}

	// Post-process and write all output files
	let bundled = 0;
	const mangleStats: { file: string; result: ConvertPrivateFieldsResult }[] = [];
	// Map from JS file path to pre-mangle content + edits, for source map adjustment
	const mangleEdits = new Map<string, { preMangleCode: string; edits: readonly import('./private-to-property.ts').TextEdit[] }>();
	// Map from JS file path to pre-NLS content + edits, for source map adjustment
	const nlsEdits = new Map<string, { preNLSCode: string; edits: readonly import('./private-to-property.ts').TextEdit[] }>();
	// Defer .map files until all .js files are processed, because esbuild may
	// emit the .map file in a different build result than the .js file (e.g.
	// code-split chunks), and we need the NLS/mangle edits from the .js pass
	// to be available when adjusting the .map.
	const deferredMaps: { path: string; text: string; contents: Uint8Array }[] = [];
	for (const { result } of buildResults) {
		if (!result.outputFiles) {
			continue;
		}

		for (const file of result.outputFiles) {
			await fs.promises.mkdir(path.dirname(file.path), { recursive: true });

			if (file.path.endsWith('.js') || file.path.endsWith('.css')) {
				let content = file.text;

				// Convert native #private fields to regular properties BEFORE NLS
				// post-processing, so that the edit offsets align with esbuild's
				// source map coordinate system (both reference the raw esbuild output).
				// Skip extension host bundles - they expose API surface to extensions
				// where true encapsulation matters more than the perf gain.
				if (file.path.endsWith('.js') && doManglePrivates && !isExtensionHostBundle(file.path)) {
					const preMangleCode = content;
					const mangleResult = convertPrivateFields(content, file.path);
					content = mangleResult.code;
					if (mangleResult.editCount > 0) {
						mangleStats.push({ file: path.relative(path.join(REPO_ROOT, outDir), file.path), result: mangleResult });
						mangleEdits.set(file.path, { preMangleCode, edits: mangleResult.edits });
					}
				}

				// Apply NLS post-processing if enabled (JS only)
				if (file.path.endsWith('.js') && doNls && indexMap.size > 0) {
					const preNLSCode = content;
					const nlsResult = postProcessNLS(content, indexMap, preserveEnglish);
					content = nlsResult.code;
					if (nlsResult.edits.length > 0) {
						nlsEdits.set(file.path, { preNLSCode, edits: nlsResult.edits });
					}
				}

				// Rewrite sourceMappingURL to CDN URL if configured
				content = rewriteSourceMappingURL(content, path.relative(path.join(REPO_ROOT, outDir), file.path), sourceMapBaseUrl);

				await fs.promises.writeFile(file.path, content);
			} else if (file.path.endsWith('.map')) {
				// Defer .map processing until all .js files have been handled
				deferredMaps.push({ path: file.path, text: file.text, contents: file.contents });
			} else {
				// Write other files (assets, etc.) as-is
				await fs.promises.writeFile(file.path, file.contents);
			}
		}
		bundled++;
	}

	// Second pass: process deferred .map files now that all mangle/NLS edits
	// have been collected from .js processing above.
	for (const mapFile of deferredMaps) {
		const jsPath = mapFile.path.replace(/\.map$/, '');
		const mangle = mangleEdits.get(jsPath);
		const nls = nlsEdits.get(jsPath);

		if (mangle || nls) {
			let mapJson = JSON.parse(mapFile.text);
			if (mangle) {
				mapJson = adjustSourceMap(mapJson, mangle.preMangleCode, mangle.edits);
			}
			if (nls) {
				mapJson = adjustSourceMap(mapJson, nls.preNLSCode, nls.edits);
			}
			await fs.promises.writeFile(mapFile.path, JSON.stringify(mapJson));
		} else {
			await fs.promises.writeFile(mapFile.path, mapFile.contents);
		}
	}

	// Syntax-check JS files that were post-processed (mangle-privates, NLS).
	// These steps do raw string surgery on bundled JS so a bug could silently
	// produce syntactically broken output. Catch it here at build time.
	// Uses esbuild.transform() as a parser since the bundles are ESM.
	const postProcessedFiles = new Set([...mangleEdits.keys(), ...nlsEdits.keys()]);
	if (postProcessedFiles.size > 0) {
		const errors = (await Promise.all([...postProcessedFiles].map(async jsPath => {
			try {
				const src = await fs.promises.readFile(jsPath, 'utf-8');
				await esbuild.transform(src, { loader: 'js', format: 'esm' });
				return undefined;
			} catch (e: unknown) {
				const rel = path.relative(path.join(REPO_ROOT, outDir), jsPath);
				const message = e instanceof Error ? e.message : String(e);
				return { rel, message };
			}
		}))).filter(error => error !== undefined).sort((a, b) => a.rel.localeCompare(b.rel));
		if (errors.length > 0) {
			throw new Error(`[bundle] Syntax errors in post-processed JS files:\n${errors.map(e => `${e.rel}: ${e.message}`).join('\n')}`);
		}
		console.log(`[bundle] Syntax check passed for ${postProcessedFiles.size} post-processed JS files`);
	}

	// Log mangle-privates stats
	if (doManglePrivates && mangleStats.length > 0) {
		let totalClasses = 0, totalFields = 0, totalEdits = 0, totalElapsed = 0;
		for (const { file, result } of mangleStats) {
			console.log(`[mangle-privates] ${file}: ${result.classCount} classes, ${result.fieldCount} fields, ${result.editCount} edits, ${result.elapsed}ms`);
			totalClasses += result.classCount;
			totalFields += result.fieldCount;
			totalEdits += result.editCount;
			totalElapsed += result.elapsed;
		}
		console.log(`[mangle-privates] Total: ${totalClasses} classes, ${totalFields} fields, ${totalEdits} edits, ${totalElapsed}ms`);
	}

	// Copy resources (curated per-target patterns for production)
	await copyResources(path.join(REPO_ROOT, SRC_DIR), outDirPath, target, doMinify, sourceMapBaseUrl);

	// Compile standalone TypeScript files (like Electron preload scripts) that cannot be bundled
	await compileStandaloneFiles(path.join(REPO_ROOT, SRC_DIR), outDirPath, target, doMinify, sourceMapBaseUrl);

	if (allEntryPoints.includes(sessionsWebEntryPoint)) {
		await bundleDevTunnelsWeb({
			minify: doMinify,
			outDir: path.join(outDir, devTunnelsWebOutDir),
			sourceMapBaseUrl: sourceMapBaseUrl ? `${sourceMapBaseUrl}/${devTunnelsWebOutDir}` : undefined,
		});
	}

	// Finish emitted assets and copied resources before packaging computes integrity data.
	await optimizeSvgFiles(outDirPath, doMinify);

	console.log(`[bundle] Done in ${Date.now() - t1}ms (${bundled} bundles)`);
}

// ============================================================================
// Watch Mode
// ============================================================================

async function watch(): Promise<void> {
	console.log('Starting transpilation...');

	const outDir = OUT_DIR;

	// Initial setup
	await cleanDir(outDir);
	console.log(`[transpile] ${SRC_DIR} → ${outDir}`);

	// Initial full build
	const t1 = Date.now();
	try {
		await transpile(outDir, false);
		await copyAllNonTsFiles(outDir, false);
		console.log(`Finished transpilation with 0 errors after ${Date.now() - t1} ms`);
	} catch (err) {
		console.error('[watch] Initial build failed:', err);
		console.log(`Finished transpilation with 1 errors after ${Date.now() - t1} ms`);
		// Continue watching anyway
	}

	let pendingTsFiles: Set<string> = new Set();
	let pendingCopyFiles: Set<string> = new Set();
	let processingChanges = false;

	const processChanges = async () => {
		if (processingChanges) {
			return;
		}

		processingChanges = true;
		try {
			while (pendingTsFiles.size > 0 || pendingCopyFiles.size > 0) {
				console.log('Starting transpilation...');
				const t1 = Date.now();
				const tsFiles = [...pendingTsFiles];
				const filesToCopy = [...pendingCopyFiles];
				pendingTsFiles = new Set();
				pendingCopyFiles = new Set();

				try {
					if (tsFiles.length > 0) {
						console.log(`[watch] Transpiling ${tsFiles.length} file(s)...`);
						await mapWithConcurrency(tsFiles, MAX_CONCURRENT_FILE_OPERATIONS, srcPath => {
							const relativePath = path.relative(path.join(REPO_ROOT, SRC_DIR), srcPath);
							const destPath = path.join(REPO_ROOT, outDir, relativePath.replace(/\.ts$/, '.js'));
							return transpileFile(srcPath, destPath);
						});
					}

					if (filesToCopy.length > 0) {
						await mapWithConcurrency(filesToCopy, MAX_CONCURRENT_FILE_OPERATIONS, async srcPath => {
							const relativePath = path.relative(path.join(REPO_ROOT, SRC_DIR), srcPath);
							const destPath = path.join(REPO_ROOT, outDir, relativePath);
							await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
							await copyFile(srcPath, destPath);
							console.log(`[watch] Copied ${relativePath}`);
						});
					}

					console.log(`Finished transpilation with 0 errors after ${Date.now() - t1} ms`);
				} catch (err) {
					console.error('[watch] Rebuild failed:', err);
					console.log(`Finished transpilation with 1 errors after ${Date.now() - t1} ms`);
				}
			}
		} finally {
			processingChanges = false;
		}
	};

	// Watch src directory using existing gulp-watch based watcher
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const srcDir = path.join(REPO_ROOT, SRC_DIR);
	const watchStream = gulpWatch('src/**', { base: srcDir, readDelay: 200 });

	watchStream.on('data', (file: { path: string }) => {
		if (file.path.endsWith('.ts') && !file.path.endsWith('.d.ts')) {
			pendingTsFiles.add(file.path);
		} else {
			// Copy any non-TS file (matches old gulp build's `src/**` behavior)
			pendingCopyFiles.add(file.path);
		}

		if (pendingTsFiles.size > 0 || pendingCopyFiles.size > 0) {
			clearTimeout(debounceTimer);
			debounceTimer = setTimeout(processChanges, 200);
		}
	});

	console.log('[watch] Watching src/**/*.{ts,css,...} (Ctrl+C to stop)');

	// Keep process alive
	process.on('SIGINT', () => {
		console.log('\n[watch] Stopping...');
		watchStream.end();
		process.exit(0);
	});
}

// ============================================================================
// Main
// ============================================================================

// PARA-PATCH: reproducible docx-preview 0.3.7 vendor build shared by desktop and mobile.
const DOCX_PREVIEW_037_TARBALL_URL = 'https://registry.npmjs.org/docx-preview/-/docx-preview-0.3.7.tgz';
const DOCX_PREVIEW_037_TARBALL_SHA256 = 'cfc102718407e6a1d591df01aa50e070dce308fb7f7f49655927ff3b742edb77';
const DOCX_PREVIEW_037_UPSTREAM_SHA256 = 'a011a499016a269eb048b8558a3eefc94bc33568ef434235943948ff24a40005';
const DOCX_PREVIEW_037_PATCHED_SHA256 = 'be407c2f18c43cc02a66d678513bed33e698c9d1e3e88df64b5e172629a8fc74';
const DOCX_PREVIEW_037_LICENSE_SHA256 = '0ed0b35bd10cb0d990fbecf7f1e05d113d785dfbbef8332e139fc10b84a4c3d7';
const JSZIP_3101_SHA256 = 'acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e';
const JSZIP_3101_LICENSE_SHA256 = '566c953c6090b1218ca6217dd7359d45dde46581968586dc607d59a78af6a9c4';
const DOCX_PREVIEW_MOBILE_BUNDLE_SHA256 = 'c5bae3ae1f48e7db24239c4fc252c4d81d7276dcafbe9d6b2e2f86c0dabadc6e';

interface IDocxPreview037Patch {
	readonly id: string;
	readonly before: string;
	readonly after: string;
}

const docxPreview037Patches: readonly IDocxPreview037Patch[] = [
	{
		id: 'vml-stroke-attributes',
		before: 'case"fillcolor":r.attrs.fill=t.value;break;case"from"',
		after: 'case"fillcolor":r.attrs.fill=t.value;break;case"strokecolor":r.attrs.stroke=t.value.replace(/\\s*\\[[^\\]]*\\]\\s*$/,"");break;case"strokeweight":r.attrs["stroke-width"]=t.value;break;case"from"',
	},
	{
		id: 'vertical-writing-variants',
		before: 'tbRl:{writingMode:"vertical-rl",transform:"none"}};for(const a of v.elements(e))',
		after: 'tbRl:{writingMode:"vertical-rl",transform:"none"},tbRlV:{writingMode:"vertical-rl",transform:"none"},lrTbV:{writingMode:"vertical-lr",transform:"none"},tbLrV:{writingMode:"vertical-rl",transform:"rotate(180deg)"}};for(const a of v.elements(e))',
	},
	{
		id: 'table-layout-type-attribute',
		before: 'static valueOfTblLayout(e){return"fixed"==v.attr(e,"val")?"fixed":"auto"}',
		after: 'static valueOfTblLayout(e){return"fixed"==v.attr(e,"type")?"fixed":"auto"}',
	},
	{
		id: 'hanging-indent-tab-stop',
		before: ':[Ve],c=i[i.length-1],h=l.width*a',
		after: ':[Ve],c=(parseFloat(o.textIndent)<0&&i[0].pos>0&&i.unshift({pos:0,leader:"none",style:"left"}),i[i.length-1]),h=l.width*a',
	},
	{
		id: 'fixed-table-width',
		before: 'e.columns&&t.appendChild(this.renderTableColumns(e.columns)),this.renderClass(e,t)',
		after: 'e.columns&&(t.appendChild(this.renderTableColumns(e.columns)),"auto"===e.cssStyle.width&&"fixed"===e.cssStyle["table-layout"]&&e.columns.every(e=>e.width)&&(e.cssStyle.width=e.columns.reduce((e,t)=>e+parseFloat(t.width),0)+"pt"),"auto"!==e.cssStyle.width&&!e.cssStyle["table-layout"]&&(e.cssStyle["table-layout"]="fixed")),this.renderClass(e,t)',
	},
	{
		id: 'page-relative-vml-origin',
		before: 'renderVmlElement(e){var t=this.createSvgElement("svg");t.setAttribute("style",e.cssStyleText);const r=',
		after: 'renderVmlElement(e){var t=this.createSvgElement("svg");t.setAttribute("style",e.cssStyleText);/mso-position-horizontal-relative:page/.test(e.cssStyleText)&&(t.style.left="0");/mso-position-vertical-relative:page/.test(e.cssStyleText)&&(t.style.top="0");const r=',
	},
	{
		id: 'numbering-css-content',
		before: 'levelTextToContent(e,t,r,a){return`"${e.replace(/%\\d*/g,e=>{let t=parseInt(e.substring(1),10)-1;return`"counter(${this.numberingCounter(r,t)}, ${a})"`})}${{tab:"\\\\9",space:"\\\\a0"}[t]??""}"`}',
		after: 'levelTextToContent(e,t,r,a){const n=[];let l=0;const p=/%\\d*/g;let m;while(m=p.exec(e)){if(m.index>l)n.push(JSON.stringify(e.slice(l,m.index)));const lv=parseInt(m[0].substring(1),10)-1;n.push(`counter(${this.numberingCounter(r,lv)}, ${a})`);l=m.index+m[0].length}if(l<e.length)n.push(JSON.stringify(e.slice(l)));const sf={tab:\'"\\\\9"\',space:\'"\\\\a0"\'}[t];if(sf)n.push(sf);return n.join(" ")}',
	},
];

function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

function verifyHash(name: string, value: string | Uint8Array, expected: string): void {
	const actual = sha256(value);
	if (actual !== expected) {
		throw new Error(`${name} SHA-256 mismatch: expected ${expected}, got ${actual}`);
	}
}

function readTarEntry(archive: Buffer, wantedPath: string): Buffer {
	for (let offset = 0; offset + 512 <= archive.length;) {
		const header = archive.subarray(offset, offset + 512);
		if (header.every(value => value === 0)) {
			break;
		}
		const entryPath = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
		const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
		const size = Number.parseInt(sizeText || '0', 8);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error(`Invalid tar entry size for ${entryPath}`);
		}
		const contentOffset = offset + 512;
		if (entryPath === wantedPath) {
			return Buffer.from(archive.subarray(contentOffset, contentOffset + size));
		}
		offset = contentOffset + Math.ceil(size / 512) * 512;
	}
	throw new Error(`Missing ${wantedPath} in docx-preview 0.3.7 tarball`);
}

function applyDocxPreview037Patches(upstream: string): string {
	let result = upstream;
	for (const patch of docxPreview037Patches) {
		const first = result.indexOf(patch.before);
		if (first < 0 || result.indexOf(patch.before, first + patch.before.length) >= 0) {
			throw new Error(`Patch ${patch.id} expected exactly one upstream match`);
		}
		result = result.slice(0, first) + patch.after + result.slice(first + patch.before.length);
	}
	return result;
}

async function writeOrCheck(filePath: string, value: string | Uint8Array, check: boolean): Promise<void> {
	const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
	if (check) {
		const existing = await fs.promises.readFile(filePath);
		if (!existing.equals(bytes)) {
			throw new Error(`${path.relative(REPO_ROOT, filePath)} is not reproducible; run the docx-preview-037 build`);
		}
		return;
	}
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await fs.promises.writeFile(filePath, bytes);
}

async function buildDocxPreview037(outputDirectory: string | undefined, check: boolean): Promise<void> {
	const response = await fetch(DOCX_PREVIEW_037_TARBALL_URL);
	if (!response.ok) {
		throw new Error(`Unable to download docx-preview 0.3.7: HTTP ${response.status}`);
	}
	const tarball = Buffer.from(await response.arrayBuffer());
	verifyHash('docx-preview 0.3.7 tarball', tarball, DOCX_PREVIEW_037_TARBALL_SHA256);
	const archive = gunzipSync(tarball);
	const upstream = readTarEntry(archive, 'package/dist/docx-preview.min.js').toString('utf8');
	const docxLicense = readTarEntry(archive, 'package/LICENSE').toString('utf8').replaceAll('\r\n', '\n');
	verifyHash('upstream docx-preview.min.js', upstream, DOCX_PREVIEW_037_UPSTREAM_SHA256);
	verifyHash('docx-preview license', docxLicense, DOCX_PREVIEW_037_LICENSE_SHA256);
	const patched = applyDocxPreview037Patches(upstream);
	verifyHash('patched docx-preview.min.js', patched, DOCX_PREVIEW_037_PATCHED_SHA256);

	const vendorDirectory = path.join(REPO_ROOT, 'src/vs/paradis/contrib/fileViewers/electron-browser/media/docxpreview');
	const jszip = await fs.promises.readFile(path.join(vendorDirectory, 'jszip.min.js'));
	const jszipLicense = await fs.promises.readFile(path.join(vendorDirectory, 'LICENSE-jszip'));
	verifyHash('jszip 3.10.1', jszip, JSZIP_3101_SHA256);
	verifyHash('jszip license', jszipLicense, JSZIP_3101_LICENSE_SHA256);
	const mobileBundle = `{"version": 1, "jszip": ${JSON.stringify(jszip.toString('utf8'))}, "docxPreview": ${JSON.stringify(patched)}}`;
	verifyHash('mobile docx preview bundle', mobileBundle, DOCX_PREVIEW_MOBILE_BUNDLE_SHA256);

	const pcOutput = outputDirectory ? path.resolve(REPO_ROOT, outputDirectory, 'pc') : vendorDirectory;
	const mobileOutput = outputDirectory
		? path.resolve(REPO_ROOT, outputDirectory, 'mobile/docxPreviewBundle.json')
		: path.join(REPO_ROOT, 'app/mobile/assets/docxpreview/docxPreviewBundle.json');
	await Promise.all([
		writeOrCheck(path.join(pcOutput, 'docx-preview.min.js'), patched, check),
		writeOrCheck(path.join(pcOutput, 'LICENSE-docx-preview'), docxLicense, check),
		writeOrCheck(path.join(pcOutput, 'jszip.min.js'), jszip, check),
		writeOrCheck(path.join(pcOutput, 'LICENSE-jszip'), jszipLicense, check),
		writeOrCheck(mobileOutput, mobileBundle, check),
	]);
	console.log(`[docx-preview-037] docx=${DOCX_PREVIEW_037_PATCHED_SHA256} mobile=${DOCX_PREVIEW_MOBILE_BUNDLE_SHA256}${check ? ' (checked)' : ''}`);
}

function printUsage(): void {
	// PARA-PATCH: the usage text below documents the fork-only docx-preview-037 command and its options.
	console.log(`Usage: npx tsx build/next/index.ts <command> [options]

Commands:
	build-fast         Incrementally build changed development outputs
	transpile          Transpile TypeScript to JavaScript (single-file, fast)
	bundle             Bundle entry points into optimized bundles
	docx-preview-037   Rebuild the pinned patched desktop/mobile docx-preview bundle

Options for 'build-fast':
	--force            Ignore incremental state and rebuild all lanes

Options for 'transpile':
	--watch            Watch for changes and rebuild incrementally
	--out <dir>        Output directory (default: out)
	--exclude-tests    Exclude test files from transpilation

Options for 'docx-preview-037':
	--check            Verify tracked outputs instead of writing them
	--out <dir>        Write pc/ and mobile/ outputs below a clean directory

Options for 'bundle':
	--minify           Minify bundles, copied JavaScript resources, and SVG assets
	--nls              Process NLS (localization) strings
	--mangle-privates  Convert native #private fields to regular properties
	--out <dir>        Output directory (default: out-vscode)
	--target <target>  Build target: desktop (default), server, server-web, web
	--source-map-base-url <url>  Rewrite sourceMappingURL to CDN URL

Examples:
	npx tsx build/next/index.ts build-fast
	npx tsx build/next/index.ts build-fast --force
	npx tsx build/next/index.ts transpile
	npx tsx build/next/index.ts transpile --watch
	npx tsx build/next/index.ts transpile --out out-build
	npx tsx build/next/index.ts transpile --out out-build --exclude-tests
	npx tsx build/next/index.ts bundle
	npx tsx build/next/index.ts bundle --minify --nls
	npx tsx build/next/index.ts bundle --nls --out out-vscode-min
	npx tsx build/next/index.ts bundle --minify --nls --target server --out out-vscode-reh-min
	npx tsx build/next/index.ts bundle --minify --nls --target server-web --out out-vscode-reh-web-min
`);
}

async function main(): Promise<void> {
	const t1 = Date.now();

	try {
		switch (command) {
			case 'build-fast':
				await runBuildFast(REPO_ROOT, options.force);
				break;
			case 'transpile':
				if (options.watch) {
					await watch();
				} else {
					const outDir = options.out ?? OUT_DIR;
					await cleanDir(outDir);

					// Write build date file (used by packaging to embed in product.json)
					const outDirPath = path.join(REPO_ROOT, outDir);
					await fs.promises.mkdir(outDirPath, { recursive: true });
					await fs.promises.writeFile(path.join(outDirPath, 'date'), getGitCommitDate(), 'utf8');

					console.log(`[transpile] ${SRC_DIR} → ${outDir}${options.excludeTests ? ' (excluding tests)' : ''}`);
					const t1 = Date.now();
					await transpile(outDir, options.excludeTests);
					await copyAllNonTsFiles(outDir, options.excludeTests);
					console.log(`[transpile] Done in ${Date.now() - t1}ms`);
				}
				break;

			case 'bundle':
				await bundle(options.out ?? OUT_VSCODE_DIR, options.minify, options.nls, options.manglePrivates, options.target as BuildTarget, options.sourceMapBaseUrl);
				break;
			// PARA-PATCH: dispatch the fork-only docx-preview-037 vendor build.
			case 'docx-preview-037':
				await buildDocxPreview037(options.out, options.check);
				break;

			default:
				printUsage();
				process.exit(command ? 1 : 0);
		}

		if (!options.watch) {
			console.log(`\n✓ Total: ${Date.now() - t1}ms`);
		}
	} catch (err) {
		console.error('Build failed:', err);
		process.exit(1);
	}
}

main();
