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
	paradisIsCancellationEvent,
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

/**
 * ネイティブクラッシュ（minidump / renderer OOM）は自分では `para.*` タグも `extra` も付けない。
 * それでも届いていたのは main の scope に残った renderer の明示レポートの値で、2026-09 の集計では
 * desktop のネイティブ 58 件中 56 件が別機能のタグを背負って誤った issue に束ねられていた
 * （`para.prepared=1` まで引き継ぐので分類自体を素通りする）。発生源（withScope）は塞いだが、
 * 既存ユーザーの `scope_v3` ストアには汚れた scope が永続化済みなので、ここで剥がして
 * ネイティブ用の分類に戻す。相関用の `para.pairing` は残す。
 */
function stripLeakedScopeFromNativeEvent<T extends IParadisSentryEvent>(event: T): T {
	if (event.platform !== 'native' && event.tags?.['event.environment'] !== 'native') {
		return event;
	}
	const tags = { ...event.tags };
	for (const key of ['para.scope', 'para.feature', 'para.operation', PARADIS_PREPARED_TAG]) {
		delete tags[key];
	}
	return Object.assign({}, event, { tags, extra: undefined });
}

export function paradisPrepareSentryEvent<T extends IParadisSentryEvent>(
	incoming: T,
	processType: string,
): T | null {
	const event = stripLeakedScopeFromNativeEvent(incoming);
	// 分類より先に落とす。転送されてきたイベントにも効かせたいので isAlreadyPrepared より前に置く。
	if (paradisIsCancellationEvent(event)) {
		return null;
	}
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
		// Without this, Sentry falls back to its own stacktrace-based grouping, which merges every
		// call site that throws `new Error(...)` from the same line regardless of `para.operation`
		// — see the comment on `paradisSentryFingerprint`.
		fingerprint: [fingerprint],
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
