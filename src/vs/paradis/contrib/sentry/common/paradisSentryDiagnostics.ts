/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisSanitizeSentryText, type ParadisSentryScope } from './paradisSentryCommon.js';

/**
 * Sentry's own `SeverityLevel` without importing the SDK into this Electron-agnostic module.
 * Defaults to `'error'` everywhere below, so existing call sites keep their current behavior.
 */
export type ParadisDiagnosticSeverity = 'info' | 'warning' | 'error';

export type ParadisDiagnosticReporter = (
	scope: Exclude<ParadisSentryScope, 'unknown'>,
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
	severity?: ParadisDiagnosticSeverity,
) => void;

let reporter: ParadisDiagnosticReporter | undefined;

/**
 * Connects fork-owned code to the process-specific Sentry SDK without making domain modules import
 * Electron or Sentry. This keeps those modules usable in unit tests and non-Electron tooling.
 */
export function configureParadisDiagnosticReporter(value: ParadisDiagnosticReporter): void {
	reporter = value;
}

let tagSetter: ((key: string, value: string) => void) | undefined;
/**
 * Tags set before the SDK finished loading. The Sentry import is dynamic, so callers that run
 * during startup (relay service load, pairing) would otherwise lose their correlation tag for
 * the whole session — unlike errors, there is no later retry that would re-set it.
 */
const pendingTags = new Map<string, string>();

/** Connects the correlation-tag setter to the process-specific Sentry SDK. */
export function configureParadisDiagnosticTagSetter(value: (key: string, value: string) => void): void {
	tagSetter = value;
	for (const [key, tagValue] of pendingTags) {
		value(key, tagValue);
	}
	pendingTags.clear();
}

/**
 * Sets a non-PII correlation tag so desktop and mobile events for the same pairing can be
 * matched up in Sentry. Both sides drop `user`, so without this a desktop disconnect and the
 * mobile error it caused look like two unrelated issues.
 *
 * Only ever pass a hash fragment — never a raw device id, token or URL.
 */
export function setParadisDiagnosticCorrelationTag(key: 'para.pairing', value: string): void {
	if (tagSetter === undefined) {
		pendingTags.set(key, value);
		return;
	}
	tagSetter(key, value);
}

/**
 * Attributes attached to a performance span. The `safe_` prefix is required, not decorative: it is
 * what `isParadisSafeExtraKey` uses to let a value through without editing its allow-list. Keep
 * these to counts and durations — never a path, workspace/state key, URL or repository name.
 */
export type ParadisSpanAttributes = Record<`safe_${string}`, number | string | boolean>;

export type ParadisSpanRunner = <T>(
	feature: string,
	operation: string,
	attributes: ParadisSpanAttributes | undefined,
	callback: () => T,
) => T;

let spanRunner: ParadisSpanRunner | undefined;

/**
 * Connects fork-owned code to the process-specific Sentry SDK for performance spans, mirroring
 * {@link configureParadisDiagnosticReporter}. Domain modules stay free of Electron/Sentry imports
 * and keep working in unit tests, where no runner is registered and spans are a pass-through.
 */
export function configureParadisSpanRunner(value: ParadisSpanRunner): void {
	spanRunner = value;
}

/**
 * Runs `callback` inside a Sentry span, or plainly if no SDK is wired up. Nested calls become
 * child spans of the enclosing one, so a phase breakdown falls out of the call structure.
 *
 * The callback's result is returned untouched; if it is a promise the span ends when it settles.
 */
export function runInParadisSpan<T>(
	feature: string,
	operation: string,
	attributes: ParadisSpanAttributes | undefined,
	callback: () => T,
): T {
	return spanRunner ? spanRunner(feature, operation, attributes, callback) : callback();
}

let spanAttributeSetter: ((attributes: ParadisSpanAttributes) => void) | undefined;

/** Connects the active-span attribute setter to the process-specific Sentry SDK. */
export function configureParadisSpanAttributeSetter(value: (attributes: ParadisSpanAttributes) => void): void {
	spanAttributeSetter = value;
}

/**
 * Records measurements on the span currently running, for values only known once the work is done
 * (how many processes came back, whether a deadline was hit). No-op when no span is active.
 */
export function setParadisSpanAttributes(attributes: ParadisSpanAttributes): void {
	spanAttributeSetter?.(attributes);
}

export function reportParadisDiagnosticError(
	scope: Exclude<ParadisSentryScope, 'unknown'>,
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
	severity?: ParadisDiagnosticSeverity,
): void {
	reporter?.(scope, feature, operation, error, safeExtra, severity);
}

/** Stack lines that point into our own compiled sources. Anything else (extensions, node_modules, user code) is dropped. */
const ownStackLine = /^\s+at .*\/vs\/(?:base|platform|editor|workbench|sessions|paradis|code|server)\//;
const MAX_SAFE_STACK_LINES = 20;
// 50 covers Node's longest error code (`ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND`, 49)
// and keeps a 64-hex hash from passing as a name.
const identifierLike = /^[A-Za-z_$][\w$]{0,49}$/;

/**
 * A grouping key for the error that carries no content: the constructor name of an `Error`,
 * an identifier-shaped `name`/`code` of a thrown plain object (`{ code: 'ENOENT' }`, a JSON-
 * transported `{ name, message }`), else the primitive type. Getters are never invoked twice
 * and a throwing one yields `'unknown'`.
 */
export function paradisSafeErrorName(error: unknown): string {
	try {
		if (error instanceof Error) {
			return typeof error.name === 'string' && identifierLike.test(error.name) ? error.name : 'Error';
		}
		if (typeof error === 'object' && error !== null) {
			for (const key of ['name', 'code'] as const) {
				const value = (error as Record<string, unknown>)[key];
				if (typeof value === 'string' && identifierLike.test(value)) {
					return value;
				}
			}
			return 'object';
		}
		return typeof error;
	} catch {
		return 'unknown';
	}
}

/**
 * Replaces the reported error with one whose message is the fixed feature/operation label and
 * whose stack keeps only frames inside `out/vs/**`, each run through the text sanitizer. The
 * message, `cause` and any non-`vs/` frame are dropped, so response bodies, extension code and
 * user paths never leave the process. Automatic captures already ship the same `vs/` frames, so
 * this adds grouping information (see `paradisSentryFingerprint`) without a new exposure: until
 * 2026-09 every explicit report shared one frame-less stack, and 676 unhandled errors in 90 days
 * collapsed into a single undiagnosable issue.
 */
export function toParadisSentrySafeError(
	feature: string,
	operation: string,
	error: unknown,
): Error {
	const safeError = new Error('Para Code diagnostic: ' + feature + '.' + operation);
	const header = safeError.name + ': ' + safeError.message;
	safeError.stack = header;
	if (!(error instanceof Error)) {
		return safeError;
	}
	let stack: unknown;
	try {
		stack = error.stack;
	} catch {
		return safeError;
	}
	if (typeof stack !== 'string') {
		return safeError;
	}
	const frames: string[] = [];
	for (const line of stack.split('\n')) {
		if (frames.length >= MAX_SAFE_STACK_LINES) {
			break;
		}
		if (ownStackLine.test(line.replace(/\\/g, '/'))) {
			frames.push(paradisSanitizeSentryText(line));
		}
	}
	if (frames.length > 0) {
		safeError.stack = header + '\n' + frames.join('\n');
	}
	return safeError;
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
