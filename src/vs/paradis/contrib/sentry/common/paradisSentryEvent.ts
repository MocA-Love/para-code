/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	IParadisSentryEvent,
	ParadisSentryRateLimiter,
	paradisClassifySentryEvent,
	paradisSanitizeSentryEvent,
	paradisSanitizeSentryText,
	paradisSentryFingerprint,
} from './paradisSentryCommon.js';

const limiter = new ParadisSentryRateLimiter();

export function paradisPrepareSentryEvent<T extends IParadisSentryEvent>(
	event: T,
	processType: string,
): T | null {
	const scope = paradisClassifySentryEvent(event);
	if (scope === undefined) {
		return null;
	}

	const withClassification = Object.assign({}, event, {
		tags: {
			...event.tags,
			'para.scope': scope,
			'process.type': processType,
		},
	});
	const sanitized = paradisSanitizeSentryEvent(withClassification);
	const fingerprint = paradisSentryFingerprint(sanitized);
	const decision = limiter.consume(fingerprint);
	if (!decision.allowed) {
		return null;
	}

	return Object.assign(sanitized, {
		extra: decision.suppressed > 0
			? { ...sanitized.extra, suppressed_count: decision.suppressed }
			: sanitized.extra,
	});
}

export function paradisPrepareSentryTransaction<T extends IParadisSentryEvent>(
	event: T,
	processType: string,
): T | null {
	if (!event.transaction?.startsWith('para.')) {
		return null;
	}
	return paradisSanitizeSentryEvent(Object.assign({}, event, {
		tags: {
			...event.tags,
			'para.scope': 'owned',
			'process.type': processType,
		},
	}));
}

export function paradisPrepareSentryBreadcrumb<T extends {
	category?: string;
	message?: string;
	data?: Record<string, unknown>;
}>(
	breadcrumb: T,
): T | null {
	if (!breadcrumb.category?.startsWith('para.')) {
		return null;
	}

	return {
		...breadcrumb,
		message: breadcrumb.message ? paradisSanitizeSentryText(breadcrumb.message) : breadcrumb.message,
		data: breadcrumb.data ? Object.fromEntries(Object.entries(breadcrumb.data)
			.filter(([key]) => key.startsWith('safe_') || [
				'attempt',
				'duration_ms',
				'exit_code',
				'failure_code',
				'phase',
				'reconnect_count',
				'shell_kind',
				'signal',
				'transport',
			].includes(key))
			.map(([key, value]) => [key, typeof value === 'string' ? paradisSanitizeSentryText(value) : value])) : breadcrumb.data,
	};
}
