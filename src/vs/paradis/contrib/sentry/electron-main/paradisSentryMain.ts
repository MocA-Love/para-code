/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { app } from 'electron';
import * as Sentry from '@sentry/electron/main';
import { PARADIS_SENTRY_DESKTOP_DSN, PARADIS_SENTRY_ENVIRONMENT, paradisSentryRelease } from '../common/paradisSentryConfiguration.js';
import { configureParadisDiagnosticReporter } from '../common/paradisSentryDiagnostics.js';
import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';

let initialized = false;

export function initializeParadisSentryMain(commit?: string): boolean {
	if (initialized) {
		return true;
	}

	try {
		Sentry.init({
			dsn: PARADIS_SENTRY_DESKTOP_DSN,
			environment: process.env['VSCODE_DEV'] ? 'local' : PARADIS_SENTRY_ENVIRONMENT,
			release: paradisSentryRelease(app.getVersion(), commit),
			dist: `${process.platform}-${process.arch}`,
			sendDefaultPii: false,
			attachScreenshot: false,
			includeLocalVariables: false,
			enableLogs: false,
			tracesSampler: context => context.name.startsWith('para.') ? 1 : 0,
			beforeBreadcrumb: breadcrumb => paradisPrepareSentryBreadcrumb(breadcrumb),
			beforeSend: event => paradisPrepareSentryEvent(event, 'main'),
			beforeSendTransaction: event => paradisPrepareSentryTransaction(event, 'main'),
		});

		Sentry.setTags({
			'para.scope': 'unknown',
			'process.type': 'main',
			'device.arch': process.arch,
			'os.name': process.platform,
		});
		configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra) => {
			captureParadisMainException(scope, feature, operation, error, safeExtra);
		});
		initialized = true;
		return true;
	} catch (error) {
		console.error('[Para Code] Failed to initialize Sentry; using the existing crash reporter fallback.', error);
		return false;
	}
}

export function captureParadisMainException(
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
