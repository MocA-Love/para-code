// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { describe, expect, test } from 'vitest';
import { FS_ABSOLUTE_PATH_CAPABILITY, FS_ABSOLUTE_PATH_KIND, parseFsAbsolutePathResponse } from '../src/fsAbsolutePath.js';
import { PARADIS_MOBILE_ABSOLUTE_PATH_KIND, paradisMobileAbsolutePathReply } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileAbsolutePath.js';
import { ParadisMobileCapability } from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileCompat.js';

describe('fs absolute path contract', () => {
	test('matches the PC copy and reads what the PC sends', () => {
		expect({
			kind: FS_ABSOLUTE_PATH_KIND,
			capability: FS_ABSOLUTE_PATH_CAPABILITY,
			local: parseFsAbsolutePathResponse(JSON.parse(JSON.stringify(paradisMobileAbsolutePathReply('/Users/example/app.ts', false, false)))),
			windows: parseFsAbsolutePathResponse(JSON.parse(JSON.stringify(paradisMobileAbsolutePathReply('C:\\work\\app.ts', true, true)))),
		}).toEqual({
			kind: PARADIS_MOBILE_ABSOLUTE_PATH_KIND,
			capability: ParadisMobileCapability.FsAbsolutePath,
			local: { path: '/Users/example/app.ts', remote: false, windows: false },
			windows: { path: 'C:\\work\\app.ts', remote: true, windows: true },
		});
	});

	test('refuses replies of the wrong shape', () => {
		expect([
			undefined,
			{ t: 'absolutePath', path: '', remote: false, windows: false },
			{ t: 'absolutePath', path: '/a', remote: 'no', windows: false },
			{ t: 'other', path: '/a', remote: false, windows: false },
			{ t: 'absolutePath', path: '/a\0b', remote: false, windows: false },
		].map(parseFsAbsolutePathResponse)).toEqual([undefined, undefined, undefined, undefined, undefined]);
	});
});
