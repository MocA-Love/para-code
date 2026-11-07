// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, it } from 'vitest';
import { toBase64, toBase64Portable } from '../src/util.js';

describe('toBase64', () => {
	it('matches the portable implementation across chunk boundaries and paddings', () => {
		const lengths = [0, 1, 2, 3, 4, 5, 3 * 8192 - 1, 3 * 8192, 3 * 8192 + 1, 3 * 8192 + 2, 100_003];
		const results = lengths.map(length => {
			const bytes = new Uint8Array(length);
			for (let index = 0; index < length; index++) {
				bytes[index] = (index * 131 + 7) & 0xff;
			}
			const fast = toBase64(bytes);
			return { length, same: fast === toBase64Portable(bytes), node: fast === Buffer.from(bytes).toString('base64') };
		});
		expect(results).toEqual(lengths.map(length => ({ length, same: true, node: true })));
	});

	it('reads only the given view of a larger buffer', () => {
		const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
		expect(toBase64(backing.subarray(2, 5))).toBe('AQID');
	});
});
