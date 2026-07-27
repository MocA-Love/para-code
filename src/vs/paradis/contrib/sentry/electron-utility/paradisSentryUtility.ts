/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type * as SentryUtility from '@sentry/electron/utility';
import { configureParadisDiagnosticReporter, configureParadisDiagnosticTagSetter } from '../common/paradisSentryDiagnostics.js';
import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';

let sentry: typeof SentryUtility | undefined;

// '@sentry/electron/utility' is loaded with a dynamic import so the bundler keeps it
// external and it resolves from node_modules.asar at runtime via the bootstrap loader
// hooks (a static import would get inlined into the shared-process bundle by the
// build-time @sentry inlining rule in build/lib/optimize.ts, dragging the whole
// node/opentelemetry graph — with its dynamic requires — into the bundle).
import('@sentry/electron/utility').then(Sentry => {
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
	configureParadisDiagnosticTagSetter((key, value) => Sentry.setTag(key, value));
	configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra) => {
		captureParadisUtilityException(scope, feature, operation, error, safeExtra);
	});
	sentry = Sentry;
}).catch(error => {
	console.error('[Para Code] Failed to initialize shared-process Sentry.', error);
});

export function captureParadisUtilityException(
	scope: 'owned' | 'patched',
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
): string {
	if (!sentry) {
		return '';
	}
	const Sentry = sentry;
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
	if (!sentry) {
		return callback();
	}
	return sentry.startSpan({
		name: `para.${feature}.${operation}`,
		op: `para.${feature}`,
		attributes: {
			'para.scope': 'owned',
			'para.feature': feature,
			'para.operation': operation,
		},
	}, callback);
}
