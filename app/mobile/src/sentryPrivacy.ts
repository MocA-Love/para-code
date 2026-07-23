// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export interface MobileSentryEvent {
	message?: string;
	user?: unknown;
	request?: unknown;
	tags?: Record<string, unknown>;
	extra?: Record<string, unknown>;
	breadcrumbs?: Array<{
		category?: string;
		message?: string;
		data?: Record<string, unknown>;
	}>;
	exception?: {
		values?: Array<{
			value?: string;
			stacktrace?: {
				frames?: Array<{
					filename?: string;
					abs_path?: string;
					function?: string;
				}>;
			};
		}>;
	};
	threads?: {
		values: Array<{
			stacktrace?: {
				frames?: Array<{
					filename?: string;
					abs_path?: string;
					function?: string;
				}>;
			};
		}>;
	};
}

const safeExtraKeys = new Set([
	'attempt',
	'duration_ms',
	'exit_code',
	'failure_code',
	'phase',
	'reconnect_count',
	'safe_count',
	'suppressed_count',
	'transport',
]);

export function sanitizeMobileSentryText(value: string): string {
	const normalized = value
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [Filtered]')
		.replace(/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|DSN)[A-Z0-9_]*)\s*=\s*[^\s,;]+/g, '$1=[Filtered]')
		.replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)\s*=\s*[^\s,;&#]+/gi, '$1=[Filtered]')
		.replace(/\/Users\/[^/\\\s]+/g, '~')
		.replace(/\/home\/[^/\\\s]+/g, '~')
		.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/gi, '~')
		.replace(/\b(?:https?|wss?):\/\/[^\s]+/gi, rawUrl => sanitizeMobileUrl(rawUrl));

	return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 2_000)}…`;
}

export function sanitizeMobileSentryEvent<T extends MobileSentryEvent>(event: T): T {
	const sanitizeFrames = (frames: Array<{ filename?: string; abs_path?: string; function?: string }> | undefined) => frames?.map(frame => ({
		...frame,
		filename: frame.filename ? sanitizeMobileSentryText(frame.filename) : frame.filename,
		abs_path: frame.abs_path ? sanitizeMobileSentryText(frame.abs_path) : frame.abs_path,
		function: frame.function ? sanitizeMobileSentryText(frame.function) : frame.function,
	}));
	const sanitized = {
		...event,
		message: event.message ? sanitizeMobileSentryText(event.message) : event.message,
		user: undefined,
		request: undefined,
		tags: event.tags ? Object.fromEntries(Object.entries(event.tags).map(([key, value]) => [
			key,
			value === undefined ? value : sanitizeMobileSentryText(String(value)),
		])) : event.tags,
		extra: event.extra ? sanitizeMobileRecord(event.extra) : event.extra,
		breadcrumbs: event.breadcrumbs?.filter(breadcrumb => breadcrumb.category?.startsWith('para.')).map(breadcrumb => ({
			...breadcrumb,
			message: breadcrumb.message ? sanitizeMobileSentryText(breadcrumb.message) : breadcrumb.message,
			data: breadcrumb.data ? sanitizeMobileRecord(breadcrumb.data) : breadcrumb.data,
		})),
		exception: event.exception ? {
			...event.exception,
			values: event.exception.values?.map(value => ({
				...value,
				value: value.value ? sanitizeMobileSentryText(value.value) : value.value,
				stacktrace: value.stacktrace ? {
					...value.stacktrace,
					frames: sanitizeFrames(value.stacktrace.frames),
				} : value.stacktrace,
			})),
		} : event.exception,
		threads: event.threads ? {
			...event.threads,
			values: event.threads.values.map(thread => ({
				...thread,
				stacktrace: thread.stacktrace ? {
					...thread.stacktrace,
					frames: sanitizeFrames(thread.stacktrace.frames),
				} : thread.stacktrace,
			})),
		} : event.threads,
	};
	return sanitized as T;
}

function sanitizeMobileUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		return url.protocol === 'ws:' || url.protocol === 'wss:'
			? '[WebSocket URL]'
			: `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return '[URL]';
	}
}

function sanitizeMobileRecord(record: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(record)
		.filter(([key]) => safeExtraKeys.has(key) || key.startsWith('safe_'))
		.map(([key, value]) => [key, typeof value === 'string' ? sanitizeMobileSentryText(value) : value]));
}
