/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as Sentry from '@sentry/electron/utility';
import { configureParadisDiagnosticReporter } from '../common/paradisSentryDiagnostics.js';
import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';

try {
	Sentry.init({
		sendDefaultPii: false,
		includeLocalVariables: false,
		enableLogs: false,
		tracesSampler: context => context.name.startsWith('para.') ? 1 : 0,
		beforeBreadcrumb: breadcrumb => paradisPrepareSentryBreadcrumb(breadcrumb),
		beforeSend: event => paradisPrepareSentryEvent(event, 'utility'),
		beforeSendTransaction: event => paradisPrepareSentryTransaction(event, 'utility'),
	});

	Sentry.setTags({
		'para.scope': 'unknown',
		'process.type': 'utility',
		'device.arch': process.arch,
		'os.name': process.platform,
	});
	configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra) => {
		captureParadisUtilityException(scope, feature, operation, error, safeExtra);
	});
} catch (error) {
	console.error('[Para Code] Failed to initialize shared-process Sentry.', error);
}

export function captureParadisUtilityException(
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

export function startParadisUtilitySpan<T>(
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
