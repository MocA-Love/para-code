/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Whether Para Code runs upstream's packaged Node.js compile cache generation
 * (`build/lib/nodeCompileCache.ts`, added in 1.144.0) after packaging.
 *
 * The step launches the packaged app once on the build machine. On Para Code's
 * GitHub Actions runners it failed for paracode-178: on linux x64 Chromium aborted
 * because the runner's chrome-sandbox is not setuid root, and on darwin arm64 the
 * app exited without writing the main process cache. The cache only speeds up
 * startup and the app runs the same without it, so the step stays off unless
 * `PARA_GENERATE_NODE_COMPILE_CACHE=1` is set (for trying it again on a build).
 */
export function shouldGenerateParadisNodeCompileCache(env: NodeJS.ProcessEnv = process.env): boolean {
	return env['PARA_GENERATE_NODE_COMPILE_CACHE'] === '1';
}
