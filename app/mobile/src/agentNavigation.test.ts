// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { createAgentLatestEntryToken, shouldHandleLatestEntry } from './agentNavigation.js';

describe('agent detail navigation', () => {
	it('creates a distinct latest-entry request even within the same millisecond', () => {
		const first = createAgentLatestEntryToken(1234);
		const second = createAgentLatestEntryToken(1234);
		expect(second).not.toBe(first);
	});

	it('handles each latest-entry request only once', () => {
		expect(shouldHandleLatestEntry(undefined, 'entry-1')).toBe(true);
		expect(shouldHandleLatestEntry('entry-1', 'entry-1')).toBe(false);
		expect(shouldHandleLatestEntry('entry-1', 'entry-2')).toBe(true);
		expect(shouldHandleLatestEntry(undefined, undefined)).toBe(false);
	});
});
