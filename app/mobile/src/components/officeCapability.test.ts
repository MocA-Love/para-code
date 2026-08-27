// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it, vi } from 'vitest';
import {
	MOBILE_OFFICE_ALL_FEATURES,
	MOBILE_OFFICE_FEATURE_EXCEL_VIEW,
	MOBILE_OFFICE_ORIGIN_WHITELIST,
	guardMobileOfficeNavigation,
	mobileOfficeContentSecurityPolicy,
	resolveMobileOfficeCapabilities,
	secureMobileOfficeHtml,
} from './officeCapability.js';

const legacyFeatures = {
	excelView: 'hostLegacy',
	excelDiff: 'hostLegacy',
	wordView: 'nativeBasic',
	wordDiff: 'explicitFallback',
} as const;

describe('mobile Office capability', () => {
	it.each([
		{
			name: 'old mobile / old PC',
			input: { mobileVersion: 0 as const, connected: true, host: { version: 0 as const } },
			expected: { protocolVersion: 0, route: 'relayV0', features: legacyFeatures, warnings: [], unavailableHostAction: undefined },
		},
		{
			name: 'old mobile / new PC',
			input: { mobileVersion: 0 as const, connected: true, host: { version: 1 as const, featureBits: MOBILE_OFFICE_ALL_FEATURES } },
			expected: { protocolVersion: 0, route: 'relayV0', features: legacyFeatures, warnings: [], unavailableHostAction: undefined },
		},
		{
			name: 'new mobile / old PC',
			input: { mobileVersion: 1 as const, connected: true, host: { version: 0 as const } },
			expected: { protocolVersion: 0, route: 'relayV0', features: legacyFeatures, warnings: ['office.capability.mobileHostV0'], unavailableHostAction: undefined },
		},
		{
			name: 'new mobile / new PC',
			input: { mobileVersion: 1 as const, connected: true, host: { version: 1 as const, featureBits: MOBILE_OFFICE_ALL_FEATURES } },
			expected: {
				protocolVersion: 1,
				route: 'relayV1',
				features: { excelView: 'hostSemantic', excelDiff: 'hostSemantic', wordView: 'nativeWithHostDiagnostics', wordDiff: 'hostSemantic' },
				warnings: [],
				unavailableHostAction: undefined,
			},
		},
	])('$name', ({ input, expected }) => {
		expect(resolveMobileOfficeCapabilities(input)).toEqual(expected);
	});

	it('keeps standalone Word view native and exposes one explicit PC connection action for host features', () => {
		expect(resolveMobileOfficeCapabilities({ mobileVersion: 1, connected: false })).toEqual({
			protocolVersion: 1,
			route: 'standalone',
			features: { excelView: 'explicitFallback', excelDiff: 'explicitFallback', wordView: 'nativeBasic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.mobileHostUnavailable'],
			unavailableHostAction: 'connectToPc',
		});
	});

	it('intersects a partial v1 host feature bitset without claiming unavailable Diff support', () => {
		expect(resolveMobileOfficeCapabilities({
			mobileVersion: 1,
			connected: true,
			host: { version: 1, featureBits: MOBILE_OFFICE_FEATURE_EXCEL_VIEW },
		})).toEqual({
			protocolVersion: 1,
			route: 'relayV1',
			features: { excelView: 'hostSemantic', excelDiff: 'explicitFallback', wordView: 'nativeBasic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.featureUnavailable'],
			unavailableHostAction: undefined,
		});
	});
});

describe('mobile Office WebView policy', () => {
	it('uses the exact isolated CSP and a non-wildcard injected-document origin', () => {
		const nonce = 'abcdefghijklmnop';
		expect(mobileOfficeContentSecurityPolicy(nonce)).toBe(
			"default-src 'none'; script-src 'nonce-abcdefghijklmnop'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none';"
		);
		expect(MOBILE_OFFICE_ORIGIN_WHITELIST).toEqual(['about:blank']);
		expect(mobileOfficeContentSecurityPolicy(nonce)).not.toContain('*');
	});

	it('adds the CSP once and binds every trusted inline script to the same nonce', () => {
		const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>one()</script><script type="module">two()</script></body></html>';
		const secured = secureMobileOfficeHtml(html, 'abcdefghijklmnop');
		expect(secured.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
		expect(secured.match(/<script nonce="abcdefghijklmnop"/g)).toHaveLength(2);
		expect(secured).toContain("script-src 'nonce-abcdefghijklmnop'");
	});

	it.each(['http://example.test/a', 'https://example.test/a', 'file:///private/a.docx'])(
		'denies top-frame navigation to %s',
		url => {
			const confirmExternal = vi.fn();
			expect(guardMobileOfficeNavigation({ url, isTopFrame: true }, confirmExternal)).toBe(false);
			expect(confirmExternal).toHaveBeenCalledTimes(/^https?:/.test(url) ? 1 : 0);
		}
	);

	it('allows only the injected about:blank document and routes external links through native confirmation', () => {
		const confirmExternal = vi.fn();
		expect(guardMobileOfficeNavigation({ url: 'about:blank#change-2', isTopFrame: true }, confirmExternal)).toBe(true);
		expect(guardMobileOfficeNavigation({ url: 'https://example.test/report', isTopFrame: true }, confirmExternal)).toBe(false);
		expect(confirmExternal).toHaveBeenCalledWith('https://example.test/report');
		expect(guardMobileOfficeNavigation({ url: 'javascript:alert(1)', isTopFrame: true }, confirmExternal)).toBe(false);
		expect(guardMobileOfficeNavigation({ url: 'data:text/html,unsafe', isTopFrame: true }, confirmExternal)).toBe(false);
	});
});
