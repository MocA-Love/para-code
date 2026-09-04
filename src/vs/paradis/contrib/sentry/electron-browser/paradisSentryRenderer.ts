/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type * as SentryRenderer from '@sentry/electron/renderer';
import { configureParadisDiagnosticReporter, configureParadisDiagnosticTagSetter, configureParadisSpanAttributeSetter, configureParadisSpanRunner, ParadisDiagnosticSeverity, ParadisSpanAttributes, toParadisSentrySafeError } from '../common/paradisSentryDiagnostics.js';

import { paradisPrepareSentryBreadcrumb, paradisPrepareSentryEvent, paradisPrepareSentryTransaction } from '../common/paradisSentryEvent.js';
import { paradisReportInsecureContextSentinel } from '../common/paradisInsecureContextSentinel.js';

/**
 * Sample rate for spans that trace a routine user action rather than a failure.
 *
 * Errors are rare and every one is worth a payload; a space switch happens dozens of times a day
 * per user, so sending all of them would change the volume by orders of magnitude and there is no
 * rate limiter on the transaction path (`paradisPrepareSentryTransaction` deliberately skips the
 * one that guards events).
 *
 * **一時的に全件にしてある（2026-08-06）。** 0.1 で回した期間の実績は `para.workspaceSwitch.*` が
 * **本番で1件も届かない**というもので、しかもこのプロジェクトには renderer 由来の transaction が
 * 一度も存在しない。「そもそも経路が生きているのか」と「抽選で落ちているだけか」を区別できないと
 * 何も調整できないので、まず母数を作る。**分布が取れたら 0.1 へ戻すこと。**
 *
 * Only list actions that are that frequent here. Answering a question happens a few times a day at
 * most, so those spans stay at full rate — sampling them would leave too little to diagnose.
 */
const PARADIS_ROUTINE_TRACE_SAMPLE_RATE = 1;
const PARADIS_ROUTINE_TRACE_PREFIXES = ['para.workspaceSwitch.'];

let sentry: typeof SentryRenderer | undefined;

// The development workbench is loaded directly from transpiled ESM over vscode-file://, where a
// browser cannot resolve npm bare specifiers. Keep this import asynchronous so an unavailable SDK
// disables diagnostics without preventing the workbench from starting. Production builds inline
// this renderer-only import via inlineParadisSentryPlugin in build/next/index.ts.
import('@sentry/electron/renderer').then(Sentry => {
	Sentry.init({
		sendDefaultPii: false,
		enableLogs: false,
		tracesSampler: context => {
			if (!context.name.startsWith('para.')) {
				return 0;
			}
			return PARADIS_ROUTINE_TRACE_PREFIXES.some(prefix => context.name.startsWith(prefix))
				? PARADIS_ROUTINE_TRACE_SAMPLE_RATE
				: 1;
		},
		beforeBreadcrumb: breadcrumb => paradisPrepareSentryBreadcrumb(breadcrumb),
		beforeSend: event => paradisPrepareSentryEvent(event, 'renderer'),
		beforeSendTransaction: event => paradisPrepareSentryTransaction(event, 'renderer'),
	});

	Sentry.setTags({
		'para.scope': 'unknown',
		'process.type': 'renderer',
	});
	configureParadisDiagnosticTagSetter((key, value) => Sentry.setTag(key, value));
	configureParadisSpanRunner((feature, operation, attributes, callback) =>
		startParadisRendererSpan(feature, operation, callback, attributes));
	configureParadisSpanAttributeSetter(attributes => Sentry.getActiveSpan()?.setAttributes(attributes));
	configureParadisDiagnosticReporter((scope, feature, operation, error, safeExtra, severity) => {
		captureParadisRendererException(scope, feature, operation, error, safeExtra, severity);
	});
	sentry = Sentry;
}).catch(error => {
	console.error('[Para Code] Failed to initialize renderer Sentry.', error);
}).finally(() => {
	// **The sentinel must not depend on Sentry having come up.** It used to sit in its own
	// try/catch precisely so that a failed `Sentry.init` could not take it down with it, and a
	// broken Sentry is exactly when an insecure context is most likely to go unnoticed.
	try {
		reportParadisInsecureContextSentinel();
	} catch (error) {
		console.error('[Para Code] Failed to report the insecure-context sentinel.', error);
	}
});

/** 実際の globals と Sentry を sentinel へ渡す。判定は `paradisInsecureContextSentinel.ts` 側。 */
function reportParadisInsecureContextSentinel(): void {
	paradisReportInsecureContextSentinel({
		isSecureContext: globalThis.isSecureContext,
		subtleCrypto: globalThis.crypto?.subtle,
		report: message => captureParadisRendererException('patched', 'webview', 'insecure-context', new Error(message)),
		log: message => console.error(message),
	});
}

export function captureParadisRendererException(
	scope: 'owned' | 'patched',
	feature: string,
	operation: string,
	error: unknown,
	safeExtra?: Record<string, unknown>,
	severity?: ParadisDiagnosticSeverity,
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
		if (severity) {
			sentryScope.setLevel(severity);
		}
		Sentry.addBreadcrumb({ category: `para.${feature}`, message: operation, data: safeExtra });
		return Sentry.captureException(toParadisSentrySafeError(feature, operation, error));
	});
}

export function startParadisRendererSpan<T>(
	feature: string,
	operation: string,
	callback: () => T,
	attributes?: ParadisSpanAttributes,
): T {
	if (!sentry) {
		return callback();
	}
	return sentry.startSpan({
		name: `para.${feature}.${operation}`,
		op: `para.${feature}`,
		attributes: {
			...attributes,
			'para.scope': 'owned',
			'para.feature': feature,
			'para.operation': operation,
		},
	}, callback);
}
