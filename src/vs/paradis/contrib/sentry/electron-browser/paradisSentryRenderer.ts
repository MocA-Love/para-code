/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as Sentry from '@sentry/electron/renderer';
import { configureParadisDiagnosticReporter } from '../common/paradisSentryDiagnostics.js';
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
	configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra) => {
		captureParadisRendererException(scope, feature, operation, error, safeExtra);
	});
} catch (error) {
	console.error('[Para Code] Failed to initialize renderer Sentry.', error);
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
