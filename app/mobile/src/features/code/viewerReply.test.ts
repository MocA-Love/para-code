// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { binaryReplyOf, textReplyOf, VIEWER_BAD_REPLY_MESSAGE, xlsxReplyOf } from './viewerReply.js';

function failure(read: () => unknown): string | undefined {
	try {
		read();
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe('viewerReply', () => {
	it('turns a missing or malformed reply into the plain message instead of a JS error', () => {
		expect([
			failure(() => textReplyOf(undefined)),
			failure(() => textReplyOf(null)),
			failure(() => textReplyOf('text')),
			failure(() => textReplyOf({ truncated: false })),
			failure(() => binaryReplyOf(undefined)),
			failure(() => binaryReplyOf({ data: 1 })),
			failure(() => xlsxReplyOf([])),
		]).toEqual(Array(7).fill(VIEWER_BAD_REPLY_MESSAGE));
	});

	it('passes a well-formed reply through and drops only a malformed image source', () => {
		expect([
			textReplyOf({ content: '# a', truncated: false, size: 3 }),
			textReplyOf({ content: '<p>', truncated: false, size: 3, htmlImages: { token: 't', count: 2 } }),
			textReplyOf({ content: '<p>', truncated: false, size: 3, htmlImages: { count: 'x' } }),
			binaryReplyOf({ data: 'QUJD', size: 3 }),
			xlsxReplyOf({ html: '<table>', sheets: ['A'] }),
		]).toEqual([
			{ content: '# a', truncated: false, size: 3 },
			{ content: '<p>', truncated: false, size: 3, htmlImages: { token: 't', count: 2 } },
			{ content: '<p>', truncated: false, size: 3 },
			'QUJD',
			{ html: '<table>', sheets: ['A'] },
		]);
	});
});
