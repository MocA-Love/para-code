// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { mobileSentryRuntime } from './sentryRuntime.js';

describe('mobileSentryRuntime', () => {
	it('keeps development builds away from Sentry, native crash reporting included', () => {
		expect([mobileSentryRuntime(true), mobileSentryRuntime(false)]).toEqual([
			{ enabled: false, enableNative: false, environment: 'local' },
			{ enabled: true, enableNative: true, environment: 'production' },
		]);
	});
});
