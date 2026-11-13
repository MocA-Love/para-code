// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 旧クライアント互換の `?token=` は受けたまま、使われたら印の付いた警告を出す（Q620）。
 * 外す時期は Workers Logs でこの印を数えて決める。警告にトークンを書かない。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEPRECATED_QUERY_TOKEN_LOG, extractToken } from '../src/auth.js';

describe('extractToken', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('warns only for the deprecated query token, without the token', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const tokens = [
			extractToken(new Request('https://relay/device/dev-1/ws?role=pc', { headers: { 'Sec-WebSocket-Protocol': 'para-auth.sub-secret' } })),
			extractToken(new Request('https://relay/device/dev-1/pc/check', { headers: { 'Authorization': 'Bearer header-secret' } })),
			extractToken(new Request('https://do/?role=pair&token=query-secret')),
			extractToken(new Request('https://do/?role=pc')),
		];
		expect({ tokens, warnings: warn.mock.calls }).toEqual({
			tokens: ['sub-secret', 'header-secret', 'query-secret', null],
			warnings: [[DEPRECATED_QUERY_TOKEN_LOG, { role: 'pair' }]],
		});
	});
});
