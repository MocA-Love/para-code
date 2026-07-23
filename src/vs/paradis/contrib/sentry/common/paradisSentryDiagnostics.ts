/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ParadisSentryScope } from './paradisSentryCommon.js';

export type ParadisDiagnosticReporter = (
	scope: Exclude<ParadisSentryScope, 'unknown'>,
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
) => void;

let reporter: ParadisDiagnosticReporter | undefined;

/**
 * Connects fork-owned code to the process-specific Sentry SDK without making domain modules import
 * Electron or Sentry. This keeps those modules usable in unit tests and non-Electron tooling.
 */
export function configureParadisDiagnosticReporter(value: ParadisDiagnosticReporter): void {
	reporter = value;
}

export function reportParadisDiagnosticError(
	scope: Exclude<ParadisSentryScope, 'unknown'>,
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
): void {
	reporter?.(scope, feature, operation, error, safeExtra);
}

export function reportParadisShellEnvDiagnosticError(
	operation: 'resolve' | 'slow-resolve',
	error: unknown,
	durationMs: number,
): void {
	reportParadisDiagnosticError('owned', 'terminal-environment', operation, error, {
		duration_ms: durationMs,
		phase: 'resolve',
	});
}
