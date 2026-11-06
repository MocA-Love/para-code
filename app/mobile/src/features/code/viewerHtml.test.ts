// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { secureMobileOfficeHtml } from '../../components/officeCapability.js';
import { buildDocxHtml, buildSecureDocxHtml } from './viewerHtml.js';

describe('buildSecureDocxHtml', () => {
	test('builds the same document as securing the whole docx HTML', () => {
		const nonce = 'abcdefabcdefabcdefabcdef';
		const samples = ['', 'UEsDBAoAAAAAAA==', 'A'.repeat(30_000) + '+/=='];
		expect(samples.map(base64 => buildSecureDocxHtml(base64, nonce) === secureMobileOfficeHtml(buildDocxHtml(base64), nonce))).toEqual([true, true, true]);
	});
});
