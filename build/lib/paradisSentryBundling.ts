/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Renderer Sentry must be bundled even though its import is asynchronous: unpackaged browser ESM
 * uses the rejection as a development fallback, while packaged vscode-file pages have no npm
 * resolver. Dynamic imports used by Node-capable processes stay external for node_modules.asar.
 */
export function shouldInlineParadisSentryImport(specifier: string, importKind: string): boolean {
	return importKind !== 'dynamic-import' || specifier === '@sentry/electron/renderer';
}
