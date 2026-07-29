// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { mobileSentryRelease } from './sentryRelease.js';

describe('mobileSentryRelease', () => {
	it('names the release after app.json, keeping the native build number', () => {
		expect(mobileSentryRelease({
			version: '0.2.3',
			buildNumber: '73',
			bundleIdentifier: 'ltd.paradis.paracode.mobile',
		})).toBe('ltd.paradis.paracode.mobile@0.2.3+73');
	});

	it('falls back to the SDK default only when app.json has no version', () => {
		expect(mobileSentryRelease({ version: undefined, buildNumber: '73', bundleIdentifier: 'x' })).toBeUndefined();
		expect(mobileSentryRelease({ version: '', buildNumber: '73', bundleIdentifier: 'x' })).toBeUndefined();
	});

	it('still produces a usable release when the build number or bundle id is missing', () => {
		expect(mobileSentryRelease({ version: '0.2.3', buildNumber: undefined, bundleIdentifier: undefined }))
			.toBe('ltd.paradis.paracode.mobile@0.2.3');
	});
});
