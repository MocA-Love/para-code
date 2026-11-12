/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';

// '@sentry/electron/renderer' is statically imported by the workbench bundle,
// but packaged renderer windows load over vscode-file:// where a bare specifier can never
// resolve (no Node resolver and no importmap for npm packages) — so statically imported
// @sentry modules are inlined into the importing bundle. Dynamic @sentry imports (main and
// shared/utility processes) stay external and resolve from node_modules.asar at runtime
// via the bootstrap loader hooks.
export function inlineParadisSentryPlugin(): esbuild.Plugin {
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
