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
	/** Minidump frames name their module here instead of `filename` (an absolute binary path). */
	package?: string;
}

export interface IParadisSentryEvent {
	platform?: string;
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
			mechanism?: {
				type?: string;
				handled?: boolean;
			};
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
			type?: string;
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

/**
 * Extra/breadcrumb payload keys that carry no user content and may be sent as-is. Everything else
 * is dropped. Callers can also prefix a key with `safe_` to opt in without editing this list.
 */
export function isParadisSafeExtraKey(key: string): boolean {
	return safeExtraKeys.has(key) || key.startsWith('safe_');
}

const safeExtraKeys = new Set([
	'attempt',
	'close_code',
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

/** Debug image types produced by native crash reporting, per platform. */
const nativeDebugImageTypes = new Set(['macho', 'pe', 'pe_dotnet', 'elf']);

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
 * Exception types VS Code uses for its cancellation sentinel (`CancellationError` / `canceled()`).
 */
const paradisCancellationTypes = new Set(['Canceled', 'CancellationError']);

/**
 * Whether the SDK captured this exception on its own rather than our code reporting it.
 *
 * `para.scope` cannot be used for this. The tag is set on the current scope, and a `withScope()`
 * block leaks it onto unrelated async work started inside it: of the 30 cancellation events observed
 * in the field, three carried `para.scope: 'owned'` and `para.feature: 'file-viewers'` from a
 * concurrent explicit report they had nothing to do with. The mechanism is attached by whoever
 * captured the event, so it stays truthful.
 */
function paradisIsAutomaticCapture(mechanism: { type?: string; handled?: boolean } | undefined): boolean {
	if (mechanism === undefined) {
		return false;
	}
	return mechanism.handled === false || mechanism.type?.startsWith('auto.') === true;
}

/**
 * Cancellation is control flow, not a failure.
 *
 * Tearing a window down rejects every in-flight request with this sentinel, and the rejections land
 * on `onunhandledrejection`. Nothing is broken and the user sees nothing, yet these were the single
 * largest issue group in the project (about 40 events in two weeks) — enough to bury real failures.
 *
 * Only automatic captures are dropped, so an explicit report always survives.
 */
export function paradisIsCancellationEvent(event: IParadisSentryEvent): boolean {
	return event.exception?.values?.some(value =>
		value.type !== undefined
		&& paradisCancellationTypes.has(value.type)
		&& paradisIsAutomaticCapture(value.mechanism)) === true;
}

/**
 * Module paths that identify a native crash as coming from a process we own.
 *
 * Kept deliberately loose so it holds on every platform and in development builds: the packaged app
 * lives under `Para Code.app` / `Para Code.exe` / `para-code`, and its always-loaded framework and
 * dev-build binary are named `Electron`. The Codex app-server is a child process we spawn, and its
 * crashes explain our own `endpoint-not-ready` reports, so it counts as ours too.
 */
const paradisOwnNativeModulePatterns: readonly RegExp[] = [/para[ _-]?code/i, /electron/i, /@openai\/codex/i];

/** Collects every module path a native event names, ignoring the SDK's JavaScript sourcemap image. */
function paradisNativeModulePaths(event: IParadisSentryEvent): string[] {
	const paths: string[] = [];
	const addFrames = (frames: IParadisSentryFrame[] | undefined) => {
		for (const frame of frames ?? []) {
			const path = frame.package ?? frame.filename ?? frame.abs_path;
			if (path) {
				paths.push(path);
			}
		}
	};
	for (const value of event.exception?.values ?? []) {
		addFrames(value.stacktrace?.frames);
	}
	for (const thread of event.threads?.values ?? []) {
		addFrames(thread.stacktrace?.frames);
	}
	for (const image of event.debug_meta?.images ?? []) {
		if ((image.type === undefined || nativeDebugImageTypes.has(image.type)) && image.code_file) {
			paths.push(image.code_file);
		}
	}
	return paths;
}

/**
 * Whether a native crash belongs to a process that merely inherited our crash handler.
 *
 * On macOS the crashpad handler is installed as a Mach exception handler, which every child process
 * inherits — so anything the user starts from the integrated terminal reports its crashes as ours.
 * A Homebrew `ffplay` failing to load a dylib produced nine "Para Code crashes" this way, complete
 * with the user's own paths.
 *
 * Fails open: an event that names no module at all (renderer OOM, for instance) is kept, because
 * losing a real crash costs far more than keeping a foreign one.
 */
export function paradisIsForeignNativeCrash(event: IParadisSentryEvent): boolean {
	const paths = paradisNativeModulePaths(event);
	if (paths.length === 0) {
		return false;
	}
	return !paths.some(path => paradisOwnNativeModulePatterns.some(pattern => pattern.test(path)));
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

	// Native crashes (minidumps, renderer OOM) cannot be attributed to an individual TypeScript
	// module, so they are kept as 'unknown' rather than dropped. The Electron SDK marks them on the
	// event itself; `debug_meta` cannot be used for this, because the SDK attaches a `sourcemap`
	// debug image to *every* JavaScript event — accepting any image at all let the whole upstream
	// error stream through, which is exactly what happened until paracode-70.
	if (event.platform === 'native' || event.tags?.['event.environment'] === 'native') {
		return paradisIsForeignNativeCrash(event) ? undefined : 'unknown';
	}

	// Debug images are only consulted as an allow-list, for events shaped by something other than
	// the JS SDK. Anything unrecognised is treated as JavaScript and dropped.
	const hasNativeImage = event.debug_meta?.images?.some(
		image => image.type === undefined || nativeDebugImageTypes.has(image.type)) === true;
	if (!hasNativeImage) {
		return undefined;
	}
	return paradisIsForeignNativeCrash(event) ? undefined : 'unknown';
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
		extra: event.extra ? paradisSanitizeRecord(event.extra, isParadisSafeExtraKey) : event.extra,
		// `para.` で始まる自前の context は残す。allow-list だけだと、まとまった診断情報
		// （リレー接続の状態一式など）を送る手段が extra の平坦なキーしか無くなる。
		// 値は既存の contexts と同じく unsafeObjectKeys の否定リストで濾す。
		contexts: event.contexts ? Object.fromEntries(Object.entries(event.contexts)
			.filter(([key]) => safeContextKeys.has(key) || key.startsWith('para.'))
			.map(([key, value]) => [key, value ? paradisSanitizeRecord(value, nestedKey => !unsafeObjectKeys.test(nestedKey)) : value])) : event.contexts,
		breadcrumbs: event.breadcrumbs?.filter(breadcrumb => breadcrumb.category?.startsWith('para.')).map(breadcrumb => ({
			...breadcrumb,
			message: breadcrumb.message ? paradisSanitizeSentryText(breadcrumb.message) : breadcrumb.message,
			data: breadcrumb.data ? paradisSanitizeRecord(breadcrumb.data, isParadisSafeExtraKey) : breadcrumb.data,
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

/** Guards against self-referencing payloads: recursing forever would throw inside beforeSend. */
const PARADIS_SANITIZE_MAX_DEPTH = 4;

function paradisSanitizeRecord(
	record: Record<string, unknown>,
	keep: (key: string) => boolean,
	depth: number = 0,
): Record<string, unknown> {
	if (depth >= PARADIS_SANITIZE_MAX_DEPTH) {
		return {};
	}
	return Object.fromEntries(Object.entries(record)
		.filter(([key]) => keep(key))
		.map(([key, value]) => [key, paradisSanitizeValue(value, keep, depth)]));
}

/**
 * Arrays were previously passed through untouched, so a value such as
 * `{ safe_paths: ['/Users/alice/...'] }` reached Sentry unsanitized.
 */
function paradisSanitizeValue(value: unknown, keep: (key: string) => boolean, depth: number): unknown {
	if (typeof value === 'string') {
		return paradisSanitizeSentryText(value);
	}
	if (depth >= PARADIS_SANITIZE_MAX_DEPTH) {
		return undefined;
	}
	if (Array.isArray(value)) {
		return value.map(entry => paradisSanitizeValue(entry, keep, depth + 1));
	}
	if (isRecord(value)) {
		return paradisSanitizeRecord(value, keep, depth + 1);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
