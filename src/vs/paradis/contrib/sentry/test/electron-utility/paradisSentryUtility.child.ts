/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: isolated test scenario for the utility-process Sentry boundary.

import { registerHooks } from 'node:module';
import type { IParadisSentryEvent } from '../../common/paradisSentryCommon.js';
import {
	configureParadisDiagnosticReporter,
	configureParadisDiagnosticTagSetter,
	reportParadisDiagnosticError,
	setParadisDiagnosticCorrelationTag,
} from '../../common/paradisSentryDiagnostics.js';
import * as FakeSentry from './paradisSentrySdk.fake.js';

interface IUtilitySentryModule {
	captureParadisUtilityException(
		scope: 'owned' | 'patched',
		feature: string,
		operation: string,
		error: unknown,
		safeExtra?: Record<string, unknown>,
	): string;
	startParadisUtilitySpan<T>(feature: string, operation: string, callback: () => T): T;
}

interface IUtilitySentryInitOptions {
	readonly sendDefaultPii: boolean;
	readonly includeLocalVariables: boolean;
	readonly enableLogs: boolean;
	readonly tracesSampler: (context: { name: string }) => number;
	readonly beforeSend: (event: IParadisSentryEvent) => IParadisSentryEvent | null;
}

export interface IUtilitySentryChildResult {
	readonly initialization: {
		readonly sendDefaultPii: boolean;
		readonly includeLocalVariables: boolean;
		readonly enableLogs: boolean;
		readonly paraTraceRate: number;
		readonly upstreamTraceRate: number;
	};
	readonly forwardedEvent: {
		readonly message: string | undefined;
		readonly user: unknown | null;
		readonly request: unknown | null;
		readonly serverName: string | null;
		readonly processType: unknown;
		readonly contexts: unknown;
	};
	readonly directCaptureId: string;
	readonly spanResult: number;
	readonly tags: Record<string, unknown>;
	readonly captures: Array<{
		readonly errorMessage: string;
		readonly scope: {
			readonly tags: Record<string, unknown>;
			readonly extras: Record<string, unknown>;
		};
	}>;
	readonly breadcrumbs: unknown[];
	readonly spans: unknown[];
}

async function main(): Promise<void> {
	FakeSentry.reset();
	const fakeSdkUrl = new URL('./paradisSentrySdk.fake.js', import.meta.url).href;
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier === '@sentry/electron/utility') {
				return { shortCircuit: true, url: fakeSdkUrl };
			}
			return nextResolve(specifier, context);
		},
	});

	const utilitySentry = await import('../../electron-utility/paradisSentryUtility.js') as IUtilitySentryModule;
	await FakeSentry.waitForInitialization();
	hooks.deregister();

	const options = FakeSentry.getInitOptions() as unknown as IUtilitySentryInitOptions;
	const forwardedEvent = options.beforeSend({
		message: 'failed for /Users/alice/private.ts while requesting https://example.test/private?token=secret#fragment',
		user: { id: 'alice' },
		request: { url: 'https://example.test/private?token=secret' },
		server_name: 'alices-macbook.local',
		tags: {
			'para.prepared': '1',
			'para.scope': 'owned',
			'process.type': 'renderer',
		},
		contexts: {
			culture: { locale: 'ja-JP', timezone: 'Asia/Tokyo' },
			process: { argv: '--secret', environment: 'OPENAI_API_KEY=secret' },
			runtime: { name: 'node', version: '24', environment: 'OPENAI_API_KEY=secret', cwd: '/Users/alice/private' },
		},
	});

	const directCaptureId = utilitySentry.captureParadisUtilityException(
		'patched',
		'mobile-relay',
		'reconnect',
		new Error('relay failed'),
		{ attempt: 2 },
	);
	reportParadisDiagnosticError(
		'owned',
		'terminal-environment',
		'resolve',
		new Error('diagnostic failed'),
		{ duration_ms: 321, phase: 'resolve' },
	);
	setParadisDiagnosticCorrelationTag('para.pairing', 'pairing-hash-fragment');
	const spanResult = utilitySentry.startParadisUtilitySpan('terminal', 'resolve-shell', () => 42);

	const result = {
		initialization: {
			sendDefaultPii: options.sendDefaultPii,
			includeLocalVariables: options.includeLocalVariables,
			enableLogs: options.enableLogs,
			paraTraceRate: options.tracesSampler({ name: 'para.mobile-relay.connect' }),
			upstreamTraceRate: options.tracesSampler({ name: 'workbench.open' }),
		},
		forwardedEvent: {
			message: forwardedEvent?.message,
			user: forwardedEvent?.user ?? null,
			request: forwardedEvent?.request ?? null,
			serverName: forwardedEvent?.server_name ?? null,
			processType: forwardedEvent?.tags?.['process.type'],
			contexts: forwardedEvent?.contexts,
		},
		directCaptureId,
		spanResult,
		tags: FakeSentry.tags,
		captures: FakeSentry.captures.map(capture => ({
			errorMessage: capture.error instanceof Error ? capture.error.message : String(capture.error),
			scope: capture.scope,
		})),
		breadcrumbs: FakeSentry.breadcrumbs,
		spans: FakeSentry.spans,
	} satisfies IUtilitySentryChildResult;

	configureParadisDiagnosticReporter(() => { });
	configureParadisDiagnosticTagSetter(() => { });
	process.stdout.write(JSON.stringify(result));
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
