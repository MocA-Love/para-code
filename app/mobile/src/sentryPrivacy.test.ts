// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { sanitizeMobileSentryEvent, sanitizeMobileSentryText } from './sentryPrivacy.js';

describe('mobile Sentry privacy', () => {
	it('redacts pairing tokens, user paths, and URL parameters', () => {
		const value = sanitizeMobileSentryText(
			'Bearer pair-secret /Users/alice/workspace/file.ts wss://127.0.0.1:9999/socket?token=pair-secret#state',
		);

		expect(value).not.toContain('pair-secret');
		expect(value).not.toContain('alice');
		expect(value).not.toContain('?token=');
		expect(value).not.toContain('#state');
		expect(value).toContain('Bearer [Filtered]');
	});

	it('removes user, request, and unsafe extras while retaining Para diagnostic tags', () => {
		const event = sanitizeMobileSentryEvent({
			message: 'relay failed with token=secret',
			user: { id: 'device-id' },
			request: { url: 'wss://relay.test/?token=secret' },
			tags: { 'para.scope': 'owned', 'para.feature': 'mobile-relay', unsafe: 'secret=secret' },
			extra: { prompt: 'private prompt', safe_count: 2 },
			exception: {
				values: [{
					value: 'failed at /Users/alice/private.ts',
					stacktrace: { frames: [{ filename: '/Users/alice/private.ts' }] },
				}],
			},
			threads: {
				values: [{
					stacktrace: { frames: [{ abs_path: '/Users/alice/native.ts' }] },
				}],
			},
		});

		expect(event.user).toBeUndefined();
		expect(event.request).toBeUndefined();
		expect(event.extra).toEqual({ safe_count: 2 });
		expect(event.tags?.['para.feature']).toBe('mobile-relay');
		expect(event.tags?.unsafe).toBe('secret=[Filtered]');
		expect(event.exception?.values?.[0].stacktrace?.frames?.[0].filename).not.toContain('alice');
		expect(event.threads?.values[0].stacktrace?.frames?.[0].abs_path).not.toContain('alice');
	});
});
