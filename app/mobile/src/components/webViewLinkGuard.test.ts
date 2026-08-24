// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const openURL = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('react-native', () => ({ Linking: { openURL } }));

import { guardWebViewNavigation } from './webViewLinkGuard.js';

function request(url: string, isTopFrame?: boolean): ShouldStartLoadRequest {
	return { url, isTopFrame } as ShouldStartLoadRequest;
}

describe('guardWebViewNavigation', () => {
	beforeEach(() => openURL.mockClear());

	test('treats omitted Android isTopFrame as a top-level request', () => {
		expect(guardWebViewNavigation(request('https://example.com'))).toBe(false);
		expect(openURL).toHaveBeenCalledWith('https://example.com');
		expect(guardWebViewNavigation(request('javascript:alert(1)'))).toBe(false);
		expect(guardWebViewNavigation(request('data:text/html,unsafe'))).toBe(false);
		expect(guardWebViewNavigation(request('about:blank'))).toBe(true);
	});

	test('bypasses only an explicitly identified iframe', () => {
		expect(guardWebViewNavigation(request('https://example.com/frame', false))).toBe(true);
		expect(guardWebViewNavigation(request('javascript:frame()', false))).toBe(true);
		expect(openURL).not.toHaveBeenCalled();
	});

	test('keeps explicit top-frame behavior unchanged', () => {
		expect(guardWebViewNavigation(request('https://example.com/top', true))).toBe(false);
		expect(openURL).toHaveBeenCalledWith('https://example.com/top');
	});
});
