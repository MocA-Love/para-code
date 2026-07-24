/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { app } from 'electron';
import type * as SentryMain from '@sentry/electron/main';
import { PARADIS_SENTRY_DESKTOP_DSN, PARADIS_SENTRY_ENVIRONMENT, paradisSentryRelease } from '../common/paradisSentryConfiguration.js';
import { configureParadisDiagnosticReporter } from '../common/paradisSentryDiagnostics.js';
import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';

let sentry: typeof SentryMain | undefined;

export function initializeParadisSentryMain(commit: string | undefined, onUnavailable: () => void): void {
	if (sentry) {
		return;
	}

	// '@sentry/electron/main' MUST be loaded with a dynamic import: the packaged main
	// bundle keeps npm dependencies external (they live in node_modules.asar), and the
	// bundle's own static imports are resolved by Node's default ESM resolver BEFORE any
	// code runs — i.e. before bootstrap-esm registers the node_modules.asar loader hook.
	// A static import therefore crashes packaged builds at link time with
	// ERR_MODULE_NOT_FOUND (this bricked the paracode-68 release). By the time this
	// dynamic import executes, the loader hook is registered and resolves the package
	// from the archive.
	import('@sentry/electron/main').then(Sentry => {
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
		sentry = Sentry;
	}).catch(error => {
		console.error('[Para Code] Failed to initialize Sentry; using the existing crash reporter fallback.', error);
		onUnavailable();
	});
}

export function captureParadisMainException(
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
