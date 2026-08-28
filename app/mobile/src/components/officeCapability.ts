// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export const MOBILE_OFFICE_PROTOCOL_VERSION = 1 as const;
export const MOBILE_OFFICE_FEATURE_EXCEL_VIEW = 1 << 0;
export const MOBILE_OFFICE_FEATURE_EXCEL_DIFF = 1 << 1;
export const MOBILE_OFFICE_FEATURE_WORD_VIEW = 1 << 2;
export const MOBILE_OFFICE_FEATURE_WORD_DIFF = 1 << 3;
export const MOBILE_OFFICE_ALL_FEATURES = MOBILE_OFFICE_FEATURE_EXCEL_VIEW
	| MOBILE_OFFICE_FEATURE_EXCEL_DIFF
	| MOBILE_OFFICE_FEATURE_WORD_VIEW
	| MOBILE_OFFICE_FEATURE_WORD_DIFF;

export type MobileOfficeFileKind = 'spreadsheet' | 'docx';

/** Recognizes every OOXML extension routed through the existing fail-closed Office viewers. */
export function classifyMobileFileKind(name: string): MobileOfficeFileKind | undefined {
	if (/\.(?:xlsx|xlsm|xltx|xltm)$/i.test(name)) {
		return 'spreadsheet';
	}
	if (/\.(?:docx|docm|dotx|dotm)$/i.test(name)) {
		return 'docx';
	}
	return undefined;
}

export type MobileOfficeProtocolVersion = 0 | typeof MOBILE_OFFICE_PROTOCOL_VERSION;
export type MobileOfficeFeatureMode = 'hostLegacy' | 'hostSemantic' | 'nativeBasic' | 'nativeWithHostDiagnostics' | 'explicitFallback';

export interface MobileOfficeHostAdvertisement {
	readonly version: MobileOfficeProtocolVersion;
	readonly featureBits?: number;
}

export interface MobileOfficeCapabilityInput {
	readonly mobileVersion: MobileOfficeProtocolVersion;
	readonly connected: boolean;
	readonly host?: MobileOfficeHostAdvertisement;
}

export interface MobileOfficeCapabilities {
	readonly protocolVersion: MobileOfficeProtocolVersion;
	readonly route: 'relayV0' | 'relayV1' | 'standalone';
	readonly features: {
		readonly excelView: MobileOfficeFeatureMode;
		readonly excelDiff: MobileOfficeFeatureMode;
		readonly wordView: MobileOfficeFeatureMode;
		readonly wordDiff: MobileOfficeFeatureMode;
	};
	readonly warnings: readonly string[];
	readonly unavailableHostAction: 'connectToPc' | undefined;
}

const legacyFeatures: MobileOfficeCapabilities['features'] = {
	excelView: 'hostLegacy',
	excelDiff: 'hostLegacy',
	wordView: 'nativeBasic',
	wordDiff: 'explicitFallback',
};

function supports(featureBits: number, feature: number): boolean {
	return (featureBits & feature) === feature;
}

/** Resolves the mobile/host compatibility matrix without claiming unavailable semantic support. */
export function resolveMobileOfficeCapabilities(input: MobileOfficeCapabilityInput): MobileOfficeCapabilities {
	if (!input.connected || input.host === undefined) {
		return {
			protocolVersion: input.mobileVersion,
			route: 'standalone',
			features: { excelView: 'explicitFallback', excelDiff: 'explicitFallback', wordView: 'nativeBasic', wordDiff: 'explicitFallback' },
			warnings: ['office.capability.mobileHostUnavailable'],
			unavailableHostAction: 'connectToPc',
		};
	}
	if (input.mobileVersion === 0) {
		return { protocolVersion: 0, route: 'relayV0', features: legacyFeatures, warnings: [], unavailableHostAction: undefined };
	}
	if (input.host.version === 0) {
		return { protocolVersion: 0, route: 'relayV0', features: legacyFeatures, warnings: ['office.capability.mobileHostV0'], unavailableHostAction: undefined };
	}
	const featureBits = input.host.featureBits ?? 0;
	const complete = featureBits === MOBILE_OFFICE_ALL_FEATURES;
	return {
		protocolVersion: 1,
		route: 'relayV1',
		features: {
			excelView: supports(featureBits, MOBILE_OFFICE_FEATURE_EXCEL_VIEW) ? 'hostSemantic' : 'explicitFallback',
			excelDiff: supports(featureBits, MOBILE_OFFICE_FEATURE_EXCEL_DIFF) ? 'hostSemantic' : 'explicitFallback',
			wordView: supports(featureBits, MOBILE_OFFICE_FEATURE_WORD_VIEW) ? 'nativeWithHostDiagnostics' : 'nativeBasic',
			wordDiff: supports(featureBits, MOBILE_OFFICE_FEATURE_WORD_DIFF) ? 'hostSemantic' : 'explicitFallback',
		},
		warnings: complete ? [] : ['office.capability.featureUnavailable'],
		unavailableHostAction: undefined,
	};
}

/** Only the document installed by `source={{ html }}` may become the top-level Office WebView page. */
export const MOBILE_OFFICE_ORIGIN_WHITELIST = Object.freeze(['about:blank'] as const);

function assertNonce(nonce: string): void {
	if (!/^[A-Za-z\d_-]{16,128}$/.test(nonce)) {
		throw new TypeError('Invalid mobile Office CSP nonce');
	}
}

/** Creates a per-document CSP nonce from the React Native crypto polyfill. */
export function createMobileOfficeNonce(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Exact CSP shared by all script-enabled Mobile Office injected documents. */
export function mobileOfficeContentSecurityPolicy(nonce: string): string {
	assertNonce(nonce);
	return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none';`;
}

/**
 * Applies the exact CSP to trusted host-generated Office HTML and binds its own inline scripts to
 * one nonce. Document text has already been escaped by the renderer; this function never interprets
 * or inserts document-provided markup.
 */
export function secureMobileOfficeHtml(html: string, nonce: string): string {
	const csp = mobileOfficeContentSecurityPolicy(nonce);
	if (!/<head(?:\s[^>]*)?>/i.test(html) || /http-equiv\s*=\s*["']Content-Security-Policy["']/i.test(html)) {
		throw new TypeError('Invalid mobile Office HTML shell');
	}
	const scripts = html.replace(/<script(?=[\s>])([^>]*)>/gi, (_match, attributes: string) => {
		const safeAttributes = attributes.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
		return `<script nonce="${nonce}"${safeAttributes}>`;
	});
	const meta = `<meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
	return scripts.replace(/(<head(?:\s[^>]*)?>)/i, `$1${meta}`);
}

export interface MobileOfficeNavigationRequest {
	readonly url: string;
	readonly isTopFrame?: boolean;
}

/** Denies Office WebView navigation; safe HTTP(S) links are handed to a native confirmation UI. */
export function guardMobileOfficeNavigation(request: MobileOfficeNavigationRequest, confirmExternal: (url: string) => void): boolean {
	if (request.isTopFrame !== false && /^about:blank(?:#.*)?$/i.test(request.url)) {
		return true;
	}
	if (request.isTopFrame !== false && /^https?:\/\//i.test(request.url)) {
		confirmExternal(request.url);
	}
	return false;
}
