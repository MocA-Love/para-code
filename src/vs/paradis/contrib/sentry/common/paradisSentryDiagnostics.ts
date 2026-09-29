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
/**
 * Node's own frames (`at afterWriteDispatched (node:internal/stream_base_commons:161:15)`). They name
 * no user file, and for errors raised inside Node — an `EPIPE` relayed over IPC, for instance — they
 * are the only frames there are.
 */
const nodeInternalStackLine = /^\s+at (?:[^()]* \()?node:[\w/.-]+:\d+:\d+\)?$/;
/**
 * A dependency shipped inside the app (`.../Contents/Resources/app/node_modules[.asar]/...`,
 * `...\resources\app\node_modules\...`). Rewritten to `app:///node_modules/<package>/<file>`, so neither
 * the install location nor a user's own `node_modules` (which does not match) leaves the process.
 */
const shippedDependencyStackLine = /^(?<prefix>\s+at (?:[^()]* \()?)[^()]*\/resources\/app\/node_modules(?:\.asar(?:\.unpacked)?)?\/(?<module>[^()]+:\d+:\d+)(?<suffix>\)?)$/i;
/** Own (`out/vs`) frames and foreign (Node, shipped dependency) frames are capped separately, so a deep dependency stack cannot push our own frames out. */
const MAX_SAFE_OWN_STACK_LINES = 20;
const MAX_SAFE_FOREIGN_STACK_LINES = 10;
/** Stack lines are cut to this before matching: a minified frame can be very long, and the patterns scan it. */
const MAX_STACK_LINE_LENGTH = 1_000;
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
			// A built-in instance thrown as-is (an `Event`, a `DOMException`-like host object) is told
			// apart by its class. Only built-ins: our own classes are renamed by minification, so their
			// name would change with every release and split the issue each time.
			const constructor: unknown = Object.getPrototypeOf(error)?.constructor;
			const constructorName: unknown = typeof constructor === 'function' ? constructor.name : undefined;
			if (typeof constructorName === 'string' && constructorName !== 'Object' && identifierLike.test(constructorName)
				&& (globalThis as Record<string, unknown>)[constructorName] === constructor) {
				return constructorName;
			}
			return 'object';
		}
		return typeof error;
	} catch {
		return 'unknown';
	}
}

/** The sanitized form of one stack line and whether it is ours, or `undefined` when the line must not leave the process. */
function toParadisSafeStackLine(rawLine: string): { readonly line: string; readonly own: boolean } | undefined {
	const line = rawLine.length > MAX_STACK_LINE_LENGTH ? rawLine.slice(0, MAX_STACK_LINE_LENGTH) : rawLine;
	const forwardSlashed = line.replace(/\\/g, '/');
	if (ownStackLine.test(forwardSlashed)) {
		return { line: paradisSanitizeSentryText(line), own: true };
	}
	if (nodeInternalStackLine.test(line)) {
		return { line: paradisSanitizeSentryText(line), own: false };
	}
	const dependency = shippedDependencyStackLine.exec(forwardSlashed);
	if (dependency?.groups) {
		return { line: paradisSanitizeSentryText(`${dependency.groups.prefix}app:///node_modules/${dependency.groups.module}${dependency.groups.suffix}`), own: false };
	}
	return undefined;
}

/**
 * Replaces the reported error with one whose message is the fixed feature/operation label and
 * whose stack keeps three kinds of frames, each run through the text sanitizer: our own
 * (`out/vs/**`), Node's internal ones (`node:...`) and dependencies shipped inside the app
 * (rewritten to `app:///node_modules/<package>/<file>`). Own frames are capped at 20 and the other
 * two together at 10, so a deep dependency stack cannot push ours out. The message, `cause` and
 * every other frame (extensions, a user's own `node_modules`, user paths) are dropped, so response
 * bodies, extension code and user paths never leave the process. This adds grouping information
 * (see `paradisSentryFingerprint`) without a new exposure: until 2026-09 every explicit report
 * shared one frame-less stack, and 676 unhandled errors in 90 days collapsed into a single
 * undiagnosable issue.
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
	let ownCount = 0;
	let foreignCount = 0;
	for (const line of stack.split('\n')) {
		if (ownCount >= MAX_SAFE_OWN_STACK_LINES && foreignCount >= MAX_SAFE_FOREIGN_STACK_LINES) {
			break;
		}
		const safeLine = toParadisSafeStackLine(line);
		if (safeLine === undefined) {
			continue;
		}
		if (safeLine.own ? ownCount++ < MAX_SAFE_OWN_STACK_LINES : foreignCount++ < MAX_SAFE_FOREIGN_STACK_LINES) {
			frames.push(safeLine.line);
		}
	}
	if (frames.length > 0) {
		safeError.stack = header + '\n' + frames.join('\n');
	}
	return safeError;
}

/**
 * Names for `FileOperationResult` (`vs/platform/files/common/files.ts`), in declaration order.
 *
 * Never send the number: if upstream inserts a member mid-enum, every past event would silently
 * change meaning. It is a `const enum`, so there is no runtime reverse mapping to use instead.
 * Update this when the enum changes; an out-of-range value is sent as a number so drift shows.
 */
const FILE_OPERATION_RESULT_NAMES: readonly string[] = [
	'FILE_IS_DIRECTORY', 'FILE_NOT_FOUND', 'FILE_NOT_MODIFIED_SINCE', 'FILE_MODIFIED_SINCE',
	'FILE_MOVE_CONFLICT', 'FILE_WRITE_LOCKED', 'FILE_PERMISSION_DENIED', 'FILE_TOO_LARGE',
	'FILE_INVALID_PATH', 'FILE_NOT_DIRECTORY', 'FILE_OTHER_ERROR',
];

/** The name of a `FileOperationError`'s `fileOperationResult`, or `undefined` for any other value. */
export function paradisFileOperationResultName(error: unknown): string | undefined {
	try {
		const result = typeof error === 'object' && error !== null ? (error as { readonly fileOperationResult?: unknown }).fileOperationResult : undefined;
		if (typeof result !== 'number') {
			return undefined;
		}
		return FILE_OPERATION_RESULT_NAMES[result] ?? `fileOperationResult:${result}`;
	} catch {
		return undefined;
	}
}

/**
 * Node's system error codes worth telling apart. Only these are ever extracted from a message, so a
 * word in a user's path that happens to look like one (`/Users/x/EFOO/`) is never sent.
 */
const knownErrnoCodes = new Set([
	'EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EDQUOT', 'EBUSY', 'EEXIST', 'ENOENT', 'ENOTDIR', 'EISDIR',
	'EMFILE', 'ENFILE', 'EIO', 'EAGAIN', 'ELOOP', 'ENAMETOOLONG', 'EXDEV', 'EINVAL', 'ETIMEDOUT',
	'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ENOTEMPTY', 'ETXTBSY', 'ECANCELED',
]);

/**
 * Node's own `ERR_*` codes (`ERR_MODULE_NOT_FOUND`, ...) and CommonJS's `MODULE_NOT_FOUND`. Read only
 * from the `code` property, never from a message; they are fixed names that Node defines.
 */
const nodeErrorCode = /^(?:ERR_[A-Z0-9_]{1,45}|MODULE_NOT_FOUND)$/;

function readStringProperty(error: object, key: string): string | undefined {
	const value = (error as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}

/**
 * Content-free facts about an error for the report's `extra`, merged under the caller's own extras
 * by the process adapters. The error itself never reaches Sentry (see `toParadisSentrySafeError`),
 * so without these a `FileOperationError` or a Node system error arrives as a bare `Error`:
 * - `safe_file_result`: the `FileOperationResult` name
 * - `safe_errno`: a known Node error code, from `code` or, for errors whose code only survives in
 *   the text (`FileOperationError` wraps the provider error's message), from the message. Node's
 *   `ERR_*` codes are taken from `code` only (an extension host's module resolution failure arrives
 *   with `ERR_MODULE_NOT_FOUND` and nothing else that can be sent)
 * - `safe_syscall`: Node's `syscall` (`write`, `open`, ...) when identifier-shaped
 * - `safe_error_keys`: for a thrown non-`Error` object, its identifier-shaped property names, which
 *   tell a JSON-transported error from an event object or a result record
 */
export function paradisSafeErrorExtra(error: unknown): Record<`safe_${string}`, string> {
	const extra: Record<`safe_${string}`, string> = {};
	if (typeof error !== 'object' || error === null) {
		return extra;
	}
	try {
		const fileResult = paradisFileOperationResultName(error);
		if (fileResult !== undefined) {
			extra.safe_file_result = fileResult;
		}
		const code = readStringProperty(error, 'code');
		const errno = code !== undefined && (knownErrnoCodes.has(code) || nodeErrorCode.test(code))
			? code
			: Array.from((readStringProperty(error, 'message') ?? '').matchAll(/\b(?<code>E[A-Z]{2,14})\b/g), match => match.groups?.code)
				.find(candidate => candidate !== undefined && knownErrnoCodes.has(candidate));
		if (errno !== undefined) {
			extra.safe_errno = errno;
		}
		const syscall = readStringProperty(error, 'syscall');
		if (syscall !== undefined && /^[a-z_]{1,20}$/.test(syscall)) {
			extra.safe_syscall = syscall;
		}
		if (!(error instanceof Error)) {
			const keys = Object.keys(error).filter(key => identifierLike.test(key) && key.length <= 24).sort().slice(0, 8);
			if (keys.length > 0) {
				extra.safe_error_keys = keys.join(',');
			}
		}
	} catch {
		// A throwing getter must not break the report it is decorating.
	}
	return extra;
}

/**
 * A short hash of the error's message with its variable parts removed, sent as the
 * `para.error_message_hash` tag. It exists for errors that arrive with no usable stack (a Node error
 * relayed over IPC, an error from code outside `out/vs`): without it they all share one fingerprint
 * and one "10 minutes, 3 events" bucket, however unrelated they are (7B, 2026-09: 120 events in one
 * issue). The message itself is never sent; quoted text, paths, URLs and numbers are removed before
 * hashing so the same failure on different files still groups together.
 */
const MAX_HASHED_MESSAGE_LENGTH = 1_000;

export function paradisErrorMessageHash(error: unknown): string | undefined {
	try {
		const message = typeof error === 'object' && error !== null ? readStringProperty(error, 'message') : undefined;
		if (!message) {
			return undefined;
		}
		// Cut first: several of the patterns below are quadratic in the input length, and a message
		// can be tens of kilobytes (a serialized response body). Only the head is hashed anyway.
		const normalized = message.slice(0, MAX_HASHED_MESSAGE_LENGTH)
			// A quote only opens after a non-word character, so the apostrophe in "can't" is kept.
			.replace(/(?<!\w)(['"`])[^'"`\n]*\1/g, '_')
			.replace(/\b(?:[a-z][\w+.-]*:\/\/|file:)\S*/gi, '_')
			// Any token with a separator, which also covers the pieces of a path with spaces in it.
			.replace(/\S*[\\/]\S*/g, '_')
			// Host names, file names, dotted identifiers.
			.replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, '_')
			// Branch and worktree names, UUIDs and other hyphenated tokens.
			.replace(/\b\w+(?:-\w+)+\b/g, '_')
			.replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b|\d+/gi, '0')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 120);
		// FNV-1a, 32 bit: stable across processes and releases, and too short to be worth reversing.
		let hash = 0x811c9dc5;
		for (let index = 0; index < normalized.length; index++) {
			hash ^= normalized.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, '0');
	} catch {
		return undefined;
	}
}

/**
 * The fingerprint every process adapter puts on the capture context of an explicit report, for the
 * SDK's `Dedupe` integration and nothing else (`paradisPrepareSentryEvent` replaces it with the real
 * grouping key in beforeSend, which runs after Dedupe).
 *
 * Dedupe drops an event equal to the previous one by exception type and value, fingerprint and
 * frames. Every explicit report has the same type and value per operation (`Para Code diagnostic:
 * <feature>.<operation>`), so two different frame-less errors in a row looked identical to it and the
 * second was silently dropped before our fingerprint existed. Keying on the error's name and message
 * hash keeps a true repeat deduplicated and lets a different error through.
 */
export function paradisDedupeFingerprint(errorTags: Record<string, string>): string[] {
	return ['para.dedupe', errorTags['para.error_name'] ?? '', errorTags['para.error_message_hash'] ?? ''];
}

/**
 * Tags every process adapter attaches to an explicit report. `para.error_message_hash` only joins the
 * grouping key when the event has no frames (see `paradisSentryFingerprint`).
 */
export function paradisSafeErrorTags(error: unknown): Record<string, string> {
	const messageHash = paradisErrorMessageHash(error);
	return {
		'para.error_name': paradisSafeErrorName(error),
		...(messageHash !== undefined ? { 'para.error_message_hash': messageHash } : {}),
	};
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
