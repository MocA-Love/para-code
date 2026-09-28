/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * リレーの取り決めのうち、W2（2026-09-28）で足した定数が app/protocol と PC 側の複製
 * （src/vs/.../paradisMobileProtocol.ts）で一致していること。
 */

import { describe, expect, test } from 'vitest';
import { PARADIS_PUSH_ID_PATTERN, PARADIS_RELAY_CLOSE_CODE } from '../src/relay.js';
import {
	PARADIS_PUSH_ID_PATTERN as PC_PUSH_ID_PATTERN,
	PARADIS_RELAY_CLOSE_CODE as PC_RELAY_CLOSE_CODE,
} from '../../../src/vs/paradis/contrib/mobileRelay/common/paradisMobileProtocol.js';

describe('relay contract sync', () => {
	test('close codes and the push id pattern match the PC copy', () => {
		expect({ codes: PC_RELAY_CLOSE_CODE, pattern: PC_PUSH_ID_PATTERN.source }).toEqual({ codes: PARADIS_RELAY_CLOSE_CODE, pattern: PARADIS_PUSH_ID_PATTERN.source });
		expect(['abcdEFGH', 'a-b_c-d_', 'short', 'x'.repeat(65), 'has space!'].map(value => PARADIS_PUSH_ID_PATTERN.test(value))).toEqual([true, true, false, false, false]);
	});
});
