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

/**
 * Reports webview infrastructure failures (e.g. the "Could not register service
 * worker" fatal error) surfaced by the upstream webview element. Field reports
 * of intermittently blank webviews (image preview, rendered Markdown/HTML
 * viewers) cannot be diagnosed otherwise — upstream-scoped errors are dropped
 * by the Sentry scope filter, so this explicit `patched`-scope report is the
 * only way they reach Sentry. The message is an upstream template string plus
 * an error name; it carries no paths or user content.
 */
export function reportParadisWebviewFatalError(message: string, safeExtra?: Record<string, unknown>): void {
	reportParadisDiagnosticError('patched', 'webview', 'fatal-error', new Error(message), safeExtra);
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
