// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { OPEN_SESSION_PATH, redirectLegacyLink } from './legacyLinks.js';

describe('redirectLegacyLink', () => {
	it('sends the Live Activity link to the relay screen', () => {
		expect(redirectLegacyLink('paracode-mobile:///agent')).toBe(OPEN_SESSION_PATH);
		expect(redirectLegacyLink('paracode-mobile://agent')).toBe(OPEN_SESSION_PATH);
		expect(redirectLegacyLink('/agent')).toBe(OPEN_SESSION_PATH);
		expect(redirectLegacyLink('/agent/')).toBe(OPEN_SESSION_PATH);
	});

	it('keeps only the latest-entry token of the old query', () => {
		expect(redirectLegacyLink('paracode-mobile:///agent?latest=abc')).toBe(`${OPEN_SESSION_PATH}?latest=abc`);
		expect(redirectLegacyLink('/agent?foo=1&latest=abc#x')).toBe(`${OPEN_SESSION_PATH}?latest=abc`);
		expect(redirectLegacyLink('/agent?latest=')).toBe(OPEN_SESSION_PATH);
	});

	it('moves other old routes to the nearest screen', () => {
		expect(redirectLegacyLink('/scm')).toBe('/');
		expect(redirectLegacyLink('paracode-mobile:///terminal-settings')).toBe('/settings/terminal');
		expect(redirectLegacyLink('/ccusage')).toBe('/settings/usage/cost');
	});

	it('leaves current routes and other links alone', () => {
		expect(redirectLegacyLink('paracode-mobile://pair?d=abc')).toBeUndefined();
		expect(redirectLegacyLink('/pc/pc-1/session/1:w1')).toBeUndefined();
		expect(redirectLegacyLink('/settings/terminal')).toBeUndefined();
		expect(redirectLegacyLink('/notifications')).toBeUndefined();
		expect(redirectLegacyLink('exp+paracode-mobile://expo-development-client/?url=x')).toBeUndefined();
		expect(redirectLegacyLink('https://example.com/agent')).toBeUndefined();
	});
});
