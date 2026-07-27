/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import {
	IParadisSentryEvent,
	ParadisSentryRateLimiter,
	isParadisSafeExtraKey,
	paradisClassifySentryEvent,
	paradisSanitizeSentryEvent,
	paradisSanitizeSentryText,
	paradisSentryFingerprint,
} from './paradisSentryCommon.js';

const limiter = new ParadisSentryRateLimiter();

/**
 * このモジュールを一度通したことを示す内部マーカー。
 *
 * 判定に `para.scope` / `process.type` を使ってはいけない。どちらも各プロセスが init 直後に
 * Sentry のグローバルスコープへ設定しており（paradisSentryMain / Renderer / Utility の setTags）、
 * スコープのタグは beforeSend の前にイベントへマージされる。つまりそれらを条件にすると
 * 全イベントが「処理済み」と誤判定され、分類・サニタイズ・レートリミットが丸ごと無効になる。
 */
const PARADIS_PREPARED_TAG = 'para.prepared';

/**
 * renderer / utility の envelope は @sentry/electron が IPC で main へ渡し、main 側で
 * captureEvent として取り込み直す。その結果 main の beforeSend がもう一度走り、
 * 発生元が付けた `process.type` を 'main' で潰していた（Sentry 上でプロセス別に絞り込めない）。
 * さらにレートリミッタはモジュールスコープなので、main の limiter が全プロセスの転送イベントを
 * 同じ fingerprint で 10分3件に絞り、発生元では通ったイベントがここで追加で握り潰されていた。
 */
function isAlreadyPrepared(event: IParadisSentryEvent): boolean {
	return event.tags?.[PARADIS_PREPARED_TAG] === '1';
}

/**
 * 転送されてきた（＝既に発生元でサニタイズ済みの）イベントも、サニタイズだけは通し直す。
 *
 * main は forwarded event を captureEvent で取り込み直すため、そのタイミングで main 側の
 * integration が `server_name`（os.hostname()。macOS では「〇〇のMacBook Pro」のような個人名を
 * 含む）や `contexts.culture`（locale / timezone）を後から足す。これらは発生元のサニタイズでは
 * 原理的にカバーできない。サニタイズは allow-list とパス正規化なので再適用しても壊れない。
 * 飛ばすのは分類とレートリミットだけ（発生元で済んでいる）。
 */
function sanitizeForwardedEvent<T extends IParadisSentryEvent>(event: T): T {
	return paradisSanitizeSentryEvent(event);
}

export function paradisPrepareSentryEvent<T extends IParadisSentryEvent>(
	event: T,
	processType: string,
): T | null {
	if (isAlreadyPrepared(event)) {
		return sanitizeForwardedEvent(event);
	}
	const scope = paradisClassifySentryEvent(event);
	if (scope === undefined) {
		return null;
	}

	const withClassification = Object.assign({}, event, {
		tags: {
			...event.tags,
			'para.scope': scope,
			'process.type': processType,
			[PARADIS_PREPARED_TAG]: '1',
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
	if (isAlreadyPrepared(event)) {
		return sanitizeForwardedEvent(event);
	}
	return paradisSanitizeSentryEvent(Object.assign({}, event, {
		tags: {
			...event.tags,
			'para.scope': 'owned',
			'process.type': processType,
			[PARADIS_PREPARED_TAG]: '1',
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
		// The allow-list lives in paradisSentryCommon: keeping a second copy here let the two drift.
		data: breadcrumb.data ? Object.fromEntries(Object.entries(breadcrumb.data)
			.filter(([key]) => isParadisSafeExtraKey(key))
			.map(([key, value]) => [key, typeof value === 'string' ? paradisSanitizeSentryText(value) : value])) : breadcrumb.data,
	};
}
