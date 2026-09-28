/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: test-only fake for the external Sentry SDK.

import type * as SentryUtility from '@sentry/electron/utility';

type FakeSentrySdk = Pick<typeof SentryUtility,
	'addBreadcrumb' | 'captureException' | 'init' | 'setTag' | 'setTags' | 'startSpan'>;

/** The capture-context hint a reporter attaches to one event (never to a shared scope). */
export interface IFakeSentryCaptureContext {
	readonly tags?: Record<string, unknown>;
	readonly extra?: Record<string, unknown>;
	readonly level?: string;
	readonly fingerprint?: readonly string[];
}

export interface IFakeSentryCapture {
	readonly error: unknown;
	readonly context: IFakeSentryCaptureContext | undefined;
}

let initOptions: Record<string, unknown> | undefined;
let initializedResolvers: Array<() => void> = [];

export const breadcrumbs: unknown[] = [];
export const captures: IFakeSentryCapture[] = [];
export const spans: unknown[] = [];
export const tags: Record<string, unknown> = {};

export function reset(): void {
	initOptions = undefined;
	initializedResolvers = [];
	breadcrumbs.length = 0;
	captures.length = 0;
	spans.length = 0;
	for (const key of Object.keys(tags)) {
		delete tags[key];
	}
}

export function waitForInitialization(): Promise<void> {
	if (initOptions) {
		return Promise.resolve();
	}
	return new Promise(resolve => initializedResolvers.push(resolve));
}

export function getInitOptions(): Record<string, unknown> {
	assertInitialized(initOptions);
	return initOptions;
}

export const init: FakeSentrySdk['init'] = options => {
	initOptions = options as unknown as Record<string, unknown>;
	for (const resolve of initializedResolvers) {
		resolve();
	}
	initializedResolvers = [];
};

export const setTags: FakeSentrySdk['setTags'] = values => {
	Object.assign(tags, values);
};

export const setTag: FakeSentrySdk['setTag'] = (key, value) => {
	tags[key] = value;
};

export const addBreadcrumb: FakeSentrySdk['addBreadcrumb'] = breadcrumb => {
	breadcrumbs.push(breadcrumb);
};

export const captureException: FakeSentrySdk['captureException'] = (error, hint) => {
	captures.push({ error, context: hint as IFakeSentryCaptureContext | undefined });
	return 'fake-sentry-event-id';
};

const fakeStartSpan = <T>(options: unknown, callback: () => T): T => {
	spans.push(options);
	return callback();
};
export const startSpan = fakeStartSpan as FakeSentrySdk['startSpan'];

function assertInitialized<T>(value: T | undefined): asserts value is T {
	if (value === undefined) {
		throw new Error('The fake Sentry SDK has not been initialized');
	}
}
