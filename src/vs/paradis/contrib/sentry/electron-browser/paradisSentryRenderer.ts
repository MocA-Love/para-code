/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as Sentry from '@sentry/electron/renderer';
import { configureParadisDiagnosticReporter, configureParadisDiagnosticTagSetter } from '../common/paradisSentryDiagnostics.js';
import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';

try {
	Sentry.init({
		sendDefaultPii: false,
		enableLogs: false,
		tracesSampler: context => context.name.startsWith('para.') ? 1 : 0,
		beforeBreadcrumb: breadcrumb => paradisPrepareSentryBreadcrumb(breadcrumb),
		beforeSend: event => paradisPrepareSentryEvent(event, 'renderer'),
		beforeSendTransaction: event => paradisPrepareSentryTransaction(event, 'renderer'),
	});

	Sentry.setTags({
		'para.scope': 'unknown',
		'process.type': 'renderer',
	});
	configureParadisDiagnosticTagSetter((key, value) => Sentry.setTag(key, value));
	configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra) => {
		captureParadisRendererException(scope, feature, operation, error, safeExtra);
	});
} catch (error) {
	console.error('[Para Code] Failed to initialize renderer Sentry.', error);
}

try {
	// Regression sentinel. `vscode-file` must stay registered as a secure scheme, otherwise the
	// workbench is not a secure context, `crypto.subtle` is undefined, and every webview (Markdown
	// preview, the Para Code file viewers, the changelog, extension webviews) fails to mount.
	// Upstream surfaces this only as an unhandled rejection the first time a webview is opened, and
	// the scope filter drops upstream-only events — so report it here instead: once per window, at
	// startup, whether or not the user ever opens a webview.
	if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
		captureParadisRendererException('patched', 'webview', 'insecure-context',
			new Error('Renderer is not a secure context, so crypto.subtle is unavailable and webviews cannot mount'));
	}
} catch (error) {
	console.error('[Para Code] Failed to report the insecure-context sentinel.', error);
}

export function captureParadisRendererException(
	scope: 'owned' | 'patched',
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
): string {
	return Sentry.withScope(sentryScope => {
		sentryScope.setTags({
			'para.scope': scope,
			'para.feature': feature,
			'para.operation': operation,
		});
		if (safeExtra) {
			sentryScope.setExtras(safeExtra);
		}
		Sentry.addBreadcrumb({ category: `para.${feature}`, message: operation, data: safeExtra });
		return Sentry.captureException(error);
	});
}

export function startParadisRendererSpan<T>(
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
