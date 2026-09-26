// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { redirectLegacyLink } from './legacyLinks.js';

describe('widget links', () => {
	it('opens the session of the agent with its tab', () => {
		expect(redirectLegacyLink('paracode-mobile:///widget/session?pc=pc-1&space=1%3Aw1&terminal=t-auth&latest=w123'))
			.toBe('/pc/pc-1/session/1%3Aw1?tab=terminal%3At-auth&latest=w123');
		expect(redirectLegacyLink('/widget/session?pc=pc-1&space=1%3Aw1')).toBe('/pc/pc-1/session/1%3Aw1');
	});

	it('falls back when ids are missing', () => {
		expect(redirectLegacyLink('/widget/session?pc=pc-1')).toBe('/pc/pc-1');
		expect(redirectLegacyLink('/widget/session')).toBe('/open-session');
		expect(redirectLegacyLink('/widget/pc')).toBe('/');
		expect(redirectLegacyLink('/widget/review?pc=pc%2F1')).toBe('/pc/pc%2F1');
	});

	it('maps the other destinations', () => {
		expect(redirectLegacyLink('paracode-mobile:///widget/attention')).toBe('/open-session');
		expect(redirectLegacyLink('/widget/pc?pc=pc-1')).toBe('/pc/pc-1');
		expect(redirectLegacyLink('/widget/system?pc=pc-1')).toBe('/settings/usage/system');
		expect(redirectLegacyLink('/widget/source-control?pc=pc-1&space=1%3Aw1')).toBe('/pc/pc-1/source-control/1%3Aw1');
		expect(redirectLegacyLink('/widget/review?pc=pc-1&space=1%3Aw1')).toBe('/pc/pc-1/review/1%3Aw1');
		expect(redirectLegacyLink('/widget/pair')).toBe('/pair');
		expect(redirectLegacyLink('/widget/settings')).toBe('/settings/widgets');
		expect(redirectLegacyLink('/widget/unknown')).toBe('/');
	});

	it('ignores broken escapes instead of throwing', () => {
		expect(redirectLegacyLink('/widget/session?pc=%E0%A4%A&space=x')).toBe('/open-session');
	});
});
