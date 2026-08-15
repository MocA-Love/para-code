/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** The process details needed to construct a child-process-gone diagnostic. */
export interface IParadisChildProcessGoneDetails {
	readonly type: string;
	readonly name?: string;
	readonly serviceName?: string;
	readonly reason: string;
	readonly exitCode: number;
}

/** The process details needed to construct a render-process-gone diagnostic. */
export interface IParadisRenderProcessGoneDetails {
	readonly reason: string;
	readonly exitCode: number;
}

interface IParadisProcessGoneDiagnostic {
	readonly operation: string;
	readonly error: Error;
	readonly safeExtra: Record<string, unknown>;
}

const CLEAN_EXIT_REASON = 'clean-exit';

/**
 * Normalizes a process label for use inside a Sentry fingerprint (`paradisSentryFingerprint`).
 *
 * Every child-process-gone diagnostic throws `new Error(...)` from the same line, so without a
 * differentiating `operation` Sentry's grouping (and ours, which mirrors it via `para.operation`)
 * folds every process — GPU, Network Service, fileWatcher, extensionHost — that dies with the same
 * `reason` into a single issue (observed: a "GPU (killed)" issue with `safe_process_name: "Network
 * Service"` events mixed in). Strips a trailing instance index (`fileWatcher-3` → `fileWatcher`) so
 * repeated crashes of the same *kind* of utility process still group together instead of spawning
 * one issue per instance count.
 */
function paradisNormalizeProcessLabel(label: string): string {
	return label
		.replace(/[-_]\d+$/, '')
		.replace(/\./g, '-')
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/[^A-Za-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
}

/** Minimal event source used to register process-gone diagnostics without importing Electron. */
export interface IParadisProcessGoneEventSource {
	on(event: 'child-process-gone', listener: (event: object, details: IParadisChildProcessGoneDetails) => void): void;
	on(event: 'render-process-gone', listener: (event: object, webContents: object, details: IParadisRenderProcessGoneDetails) => void): void;
}

/** Reporter boundary consumed by process-gone diagnostics. */
export type ParadisProcessGoneReporter = (
	scope: 'owned',
	feature: 'process-lifecycle',
	operation: string,
	error: Error,
	safeExtra: Record<string, unknown>,
) => void;

/**
 * Creates a privacy-safe diagnostic payload for an unexpectedly exited child process.
 */
export function createParadisChildProcessGoneDiagnostic(details: IParadisChildProcessGoneDetails, durationMs: number): IParadisProcessGoneDiagnostic | undefined {
	if (details.reason === CLEAN_EXIT_REASON) {
		return undefined;
	}

	const label = details.name ?? details.serviceName ?? details.type;
	return {
		operation: `child-process-gone-${details.reason}-${paradisNormalizeProcessLabel(label)}`,
		error: new Error(`Child process gone: ${details.type}/${label} (${details.reason})`),
		safeExtra: {
			process_type: details.type,
			failure_code: details.reason,
			exit_code: details.exitCode,
			duration_ms: durationMs,
			safe_service_name: details.serviceName,
			safe_process_name: details.name,
		},
	};
}

/**
 * Creates a privacy-safe diagnostic payload for an unexpectedly exited renderer process.
 */
export function createParadisRenderProcessGoneDiagnostic(details: IParadisRenderProcessGoneDetails, durationMs: number): IParadisProcessGoneDiagnostic | undefined {
	if (details.reason === CLEAN_EXIT_REASON) {
		return undefined;
	}

	return {
		operation: `render-process-gone-${details.reason}`,
		error: new Error(`Renderer process gone (${details.reason})`),
		safeExtra: {
			process_type: 'renderer',
			failure_code: details.reason,
			exit_code: details.exitCode,
			duration_ms: durationMs,
		},
	};
}

/**
 * Registers process-gone handlers without coupling the diagnostic behavior to Electron.
 */
export function registerParadisProcessGoneDiagnosticListeners(eventSource: IParadisProcessGoneEventSource, reporter: ParadisProcessGoneReporter, durationMs: () => number): void {
	eventSource.on('child-process-gone', (_event, details) => {
		const diagnostic = createParadisChildProcessGoneDiagnostic(details, durationMs());
		if (diagnostic !== undefined) {
			reporter('owned', 'process-lifecycle', diagnostic.operation, diagnostic.error, diagnostic.safeExtra);
		}
	});

	eventSource.on('render-process-gone', (_event, _webContents, details) => {
		const diagnostic = createParadisRenderProcessGoneDiagnostic(details, durationMs());
		if (diagnostic !== undefined) {
			reporter('owned', 'process-lifecycle', diagnostic.operation, diagnostic.error, diagnostic.safeExtra);
		}
	});
}
