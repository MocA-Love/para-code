// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as Sentry from '@sentry/react-native';
import type { Event } from '@sentry/react-native';
import { configureMobileDiagnosticReporter } from './mobileDiagnostics.js';
import { sanitizeMobileSentryEvent, sanitizeMobileSentryText } from './sentryPrivacy.js';

const PARA_CODE_MOBILE_SENTRY_DSN = 'https://adaabae68f7bbdee1d0d9fbc1fad3463@o4511131276804096.ingest.us.sentry.io/4511784070807552';
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1_000;
const RATE_LIMIT_MAX_EVENTS = 3;

interface RateLimitEntry {
	windowStartedAt: number;
	sent: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

try {
	Sentry.init({
		dsn: PARA_CODE_MOBILE_SENTRY_DSN,
		environment: __DEV__ ? 'local' : 'development',
		sendDefaultPii: false,
		enableNative: true,
		enableNativeCrashHandling: true,
		enableNdk: true,
		enableTombstone: true,
		attachAllThreads: true,
		attachScreenshot: false,
		attachViewHierarchy: false,
		enableCaptureFailedRequests: false,
		enableAutoPerformanceTracing: false,
		enableAppStartTracking: true,
		enableAppHangTracking: true,
		appHangTimeoutInterval: 5,
		enableLogs: false,
		tracesSampler: context => context.name.startsWith('para.') || context.name.includes('app.start') ? 1 : 0,
		beforeBreadcrumb: breadcrumb => {
			if (!breadcrumb.category?.startsWith('para.')) {
				return null;
			}
			return {
				...breadcrumb,
				message: breadcrumb.message ? sanitizeMobileSentryText(breadcrumb.message) : breadcrumb.message,
				data: breadcrumb.data ? sanitizeMobileSentryEvent({ extra: breadcrumb.data }).extra : breadcrumb.data,
			};
		},
		beforeSend: event => {
			const classified = sanitizeMobileSentryEvent({
				...event,
				tags: {
					...event.tags,
					'para.scope': event.tags?.['para.scope'] ?? 'owned',
					'process.type': 'mobile',
				},
			}) as Event;
			return consumeMobileErrorQuota(classified) ? classified : null;
		},
		beforeSendTransaction: event => sanitizeMobileSentryEvent({
			...event,
			tags: {
				...event.tags,
				'para.scope': 'owned',
				'process.type': 'mobile',
			},
		}) as typeof event,
	});

	Sentry.setTags({
		'para.scope': 'owned',
		'process.type': 'mobile',
	});
	configureMobileDiagnosticReporter((feature, operation, error, safeExtra) => {
		captureMobileException(feature, operation, error, safeExtra);
	});
} catch (error) {
	console.error('[Para Code] Failed to initialize mobile Sentry.', error);
}

export function captureMobileException(
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
): string {
	return Sentry.withScope(scope => {
		scope.setTags({
			'para.scope': 'owned',
			'para.feature': feature,
			'para.operation': operation,
		});
		if (safeExtra) {
			scope.setExtras(safeExtra);
		}
		Sentry.addBreadcrumb({ category: `para.${feature}`, message: operation, data: safeExtra });
		return Sentry.captureException(error);
	}) ?? '';
}

export function startMobileSpan<T>(
	feature: string,
	operation: string,
	callback: () => T,
): T {
	return Sentry.startSpan({
		name: `para.${feature}.${operation}`,
		op: `para.${feature}`,
		attributes: {
			'para.scope': 'owned',
			'para.feature': feature,
			'para.operation': operation,
		},
	}, callback);
}

function consumeMobileErrorQuota(event: Event): boolean {
	const exception = event.exception?.values?.[0];
	const frames = exception?.stacktrace?.frames;
	const topFrame = frames?.[frames.length - 1];
	const fingerprint = [
		event.tags?.['para.feature'] ?? 'unknown',
		event.tags?.['para.operation'] ?? 'unknown',
		exception?.type ?? event.message ?? 'Error',
		topFrame?.filename ?? 'unknown',
		topFrame?.function ?? 'unknown',
	].join('|');
	const now = Date.now();
	const existing = rateLimits.get(fingerprint);
	if (!existing || now - existing.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
		rateLimits.set(fingerprint, { windowStartedAt: now, sent: 1 });
		return true;
	}
	if (existing.sent >= RATE_LIMIT_MAX_EVENTS) {
		return false;
	}
	existing.sent++;
	return true;
}
