/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export type ParadisSentryScope = 'owned' | 'patched' | 'unknown';

export interface IParadisSentryFrame {
	filename?: string;
	abs_path?: string;
	function?: string;
}

export interface IParadisSentryEvent {
	message?: string;
	logentry?: {
		message?: string;
		params?: unknown[];
	};
	user?: unknown;
	request?: unknown;
	server_name?: string;
	transaction?: string;
	tags?: Record<string, unknown>;
	extra?: Record<string, unknown>;
	contexts?: Record<string, Record<string, unknown> | undefined>;
	breadcrumbs?: Array<{
		category?: string;
		message?: string;
		data?: Record<string, unknown>;
	}>;
	exception?: {
		values?: Array<{
			type?: string;
			value?: string;
			stacktrace?: {
				frames?: IParadisSentryFrame[];
			};
		}>;
	};
	threads?: {
		values: Array<{
			stacktrace?: {
				frames?: IParadisSentryFrame[];
			};
		}>;
	};
	debug_meta?: {
		images?: Array<{
			code_file?: string | null;
			debug_file?: string | null;
		}>;
	};
}

export interface IParadisSentryRateLimitResult {
	readonly allowed: boolean;
	readonly suppressed: number;
}

interface IParadisSentryRateLimitEntry {
	windowStartedAt: number;
	sent: number;
	suppressed: number;
}

const PARADIS_SENTRY_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const PARADIS_SENTRY_RATE_LIMIT_MAX_EVENTS = 3;
const PARADIS_SENTRY_MAX_TEXT_LENGTH = 2_000;

const safeExtraKeys = new Set([
	'attempt',
	'duration_ms',
	'exit_code',
	'failure_code',
	'phase',
	'process_type',
	'reconnect_count',
	'safe_count',
	'shell_kind',
	'signal',
	'suppressed_count',
	'transport',
]);

const safeContextKeys = new Set(['app', 'device', 'electron', 'gpu', 'os', 'runtime', 'trace']);
const unsafeObjectKeys = /(?:authorization|cookie|credential|cwd|dsn|environment|env|header|password|passwd|path|prompt|secret|session|terminal|token)/i;

/**
 * Limits one normalized error to three events per process and ten-minute window.
 */
export class ParadisSentryRateLimiter {
	private readonly entries = new Map<string, IParadisSentryRateLimitEntry>();

	constructor(private readonly now: () => number = Date.now) { }

	consume(fingerprint: string): IParadisSentryRateLimitResult {
		const currentTime = this.now();
		const existing = this.entries.get(fingerprint);
		if (!existing || currentTime - existing.windowStartedAt >= PARADIS_SENTRY_RATE_LIMIT_WINDOW_MS) {
			const suppressed = existing?.suppressed ?? 0;
			this.entries.set(fingerprint, { windowStartedAt: currentTime, sent: 1, suppressed: 0 });
			return { allowed: true, suppressed };
		}

		if (existing.sent < PARADIS_SENTRY_RATE_LIMIT_MAX_EVENTS) {
			existing.sent++;
			return { allowed: true, suppressed: 0 };
		}

		existing.suppressed++;
		return { allowed: false, suppressed: existing.suppressed };
	}
}

/**
 * Removes credentials and local identity from text while retaining error semantics.
 */
export function paradisSanitizeSentryText(value: string): string {
	const normalized = value
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [Filtered]')
		.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|DSN)[A-Z0-9_]*)\s*=\s*[^\s,;]+/g, '$1=[Filtered]')
		.replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)\s*=\s*[^\s,;&#]+/gi, '$1=[Filtered]')
		.replace(/\/Users\/[^/\\\s]+/g, '~')
		.replace(/\/home\/[^/\\\s]+/g, '~')
		.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/gi, '~')
		.replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, rawUrl => paradisSanitizeUrl(rawUrl));

	return normalized.length <= PARADIS_SENTRY_MAX_TEXT_LENGTH
		? normalized
		: `${normalized.slice(0, PARADIS_SENTRY_MAX_TEXT_LENGTH)}…`;
}

/**
 * Produces the stable key used only for client-side duplicate suppression.
 */
export function paradisSentryFingerprint(event: IParadisSentryEvent): string {
	const exception = event.exception?.values?.[0];
	const frames = exception?.stacktrace?.frames;
	const topFrame = frames?.[frames.length - 1];
	return [
		event.tags?.['para.scope'] ?? 'unknown',
		event.tags?.['para.feature'] ?? 'unknown',
		event.tags?.['para.operation'] ?? 'unknown',
		exception?.type ?? event.message ?? event.debug_meta?.images?.[0]?.code_file ?? 'Error',
		topFrame?.filename ?? 'unknown',
		topFrame?.function ?? 'unknown',
	].map(value => paradisSanitizeSentryText(String(value))).join('|');
}

/**
 * Keeps explicitly classified patched code and automatic errors whose stack enters fork-owned
 * source. Upstream-only VS Code errors are deliberately not sent to the Para Code project.
 */
export function paradisClassifySentryEvent(event: IParadisSentryEvent): ParadisSentryScope | undefined {
	const explicitScope = event.tags?.['para.scope'];
	if (explicitScope === 'owned' || explicitScope === 'patched') {
		return explicitScope;
	}

	const hasOwnedFrame = event.exception?.values?.some(value => value.stacktrace?.frames?.some(frame => {
		const filename = (frame.filename ?? frame.abs_path)?.replace(/\\/g, '/').toLowerCase();
		return filename?.includes('/vs/paradis/') === true;
	})) === true;
	if (hasOwnedFrame) {
		return 'owned';
	}

	// Native minidumps cannot be attributed to an individual TypeScript module. Keep only events
	// that carry native debug images; ordinary upstream JS errors still fall through and are dropped.
	return event.debug_meta?.images?.length ? 'unknown' : undefined;
}

/**
 * Applies the same privacy boundary to automatic and explicitly captured events.
 */
export function paradisSanitizeSentryEvent<T extends IParadisSentryEvent>(event: T): T {
	const exception = event.exception ? {
		...event.exception,
		values: event.exception.values?.map(value => ({
			...value,
			value: value.value ? paradisSanitizeSentryText(value.value) : value.value,
			stacktrace: value.stacktrace ? {
				...value.stacktrace,
				frames: value.stacktrace.frames?.map(frame => ({
					...frame,
					filename: frame.filename ? paradisNormalizeSentryFramePath(frame.filename) : frame.filename,
					abs_path: frame.abs_path ? paradisNormalizeSentryFramePath(frame.abs_path) : frame.abs_path,
					function: frame.function ? paradisSanitizeSentryText(frame.function) : frame.function,
				})),
			} : value.stacktrace,
		})),
	} : event.exception;

	const debugMeta = event.debug_meta ? {
		...event.debug_meta,
		images: event.debug_meta.images?.map(image => ({
			...image,
			code_file: image.code_file ? paradisNormalizeSentryFramePath(image.code_file) : image.code_file,
			debug_file: image.debug_file ? paradisNormalizeSentryFramePath(image.debug_file) : image.debug_file,
		})),
	} : event.debug_meta;
	const threads = event.threads ? {
		...event.threads,
		values: event.threads.values.map(thread => ({
			...thread,
			stacktrace: thread.stacktrace ? {
				...thread.stacktrace,
				frames: thread.stacktrace.frames?.map(frame => ({
					...frame,
					filename: frame.filename ? paradisNormalizeSentryFramePath(frame.filename) : frame.filename,
					abs_path: frame.abs_path ? paradisNormalizeSentryFramePath(frame.abs_path) : frame.abs_path,
					function: frame.function ? paradisSanitizeSentryText(frame.function) : frame.function,
				})),
			} : thread.stacktrace,
		})),
	} : event.threads;

	const sanitized = {
		...event,
		message: event.message ? paradisSanitizeSentryText(event.message) : event.message,
		logentry: event.logentry ? {
			...event.logentry,
			message: event.logentry.message ? paradisSanitizeSentryText(event.logentry.message) : event.logentry.message,
			params: undefined,
		} : event.logentry,
		transaction: event.transaction ? paradisSanitizeSentryText(event.transaction) : event.transaction,
		user: undefined,
		request: undefined,
		server_name: undefined,
		tags: event.tags ? Object.fromEntries(Object.entries(event.tags).map(([key, value]) => [
			key,
			value === undefined ? value : paradisSanitizeSentryText(String(value)),
		])) : event.tags,
		extra: event.extra ? paradisSanitizeRecord(event.extra, key => safeExtraKeys.has(key) || key.startsWith('safe_')) : event.extra,
		contexts: event.contexts ? Object.fromEntries(Object.entries(event.contexts)
			.filter(([key]) => safeContextKeys.has(key))
			.map(([key, value]) => [key, value ? paradisSanitizeRecord(value, nestedKey => !unsafeObjectKeys.test(nestedKey)) : value])) : event.contexts,
		breadcrumbs: event.breadcrumbs?.filter(breadcrumb => breadcrumb.category?.startsWith('para.')).map(breadcrumb => ({
			...breadcrumb,
			message: breadcrumb.message ? paradisSanitizeSentryText(breadcrumb.message) : breadcrumb.message,
			data: breadcrumb.data ? paradisSanitizeRecord(breadcrumb.data, key => safeExtraKeys.has(key) || key.startsWith('safe_')) : breadcrumb.data,
		})),
		exception,
		threads,
		debug_meta: debugMeta,
	};

	return sanitized as T;
}

function paradisSanitizeUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.protocol === 'ws:' || url.protocol === 'wss:') {
			return '[WebSocket URL]';
		}
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return '[URL]';
	}
}

function paradisNormalizeSentryFramePath(value: string): string {
	const normalized = value.replace(/\\/g, '/');
	const appResourceMarker = '/Contents/Resources/app/';
	const appResourceIndex = normalized.indexOf(appResourceMarker);
	if (appResourceIndex >= 0) {
		return `app:///${normalized.slice(appResourceIndex + appResourceMarker.length)}`;
	}

	const windowsResourceMarker = '/resources/app/';
	const windowsResourceIndex = normalized.toLowerCase().indexOf(windowsResourceMarker);
	if (windowsResourceIndex >= 0) {
		return `app:///${normalized.slice(windowsResourceIndex + windowsResourceMarker.length)}`;
	}

	return paradisSanitizeSentryText(normalized);
}

function paradisSanitizeRecord(
	record: Record<string, unknown>,
	keep: (key: string) => boolean,
): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record)
		.filter(([key]) => keep(key))
		.map(([key, value]) => [
			key,
			typeof value === 'string'
				? paradisSanitizeSentryText(value)
				: isRecord(value)
					? paradisSanitizeRecord(value, keep)
					: value,
		]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
