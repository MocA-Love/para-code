// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { errorKind } from './errorKind.js';

describe('errorKind', () => {
	it('keeps only the name of an error, not its message', () => {
		expect(errorKind(new TypeError('/Users/someone/secret.png not found'))).toBe('TypeError');
	});

	it('adds the code when the error has one', () => {
		const error = Object.assign(new Error('failed to read photo.jpg'), { code: 'ENOENT' });
		expect(errorKind(error)).toBe('Error (ENOENT)');
	});

	it('falls back to the type for non-errors', () => {
		expect(errorKind('photo.jpg')).toBe('string');
		expect(errorKind(undefined)).toBe('undefined');
	});
});
