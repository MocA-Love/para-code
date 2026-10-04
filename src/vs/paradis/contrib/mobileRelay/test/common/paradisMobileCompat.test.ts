/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_MOBILE_APP_CAPABILITIES,
	PARADIS_MOBILE_PC_CAPABILITIES,
	paradisEvaluateMobileCompat,
	paradisHasMobileCapability,
	paradisIsAcceptedMobileWireVersion,
	paradisParseMobileCapabilities,
	type IParadisMobileCompatInput,
} from '../../common/paradisMobileCompat.js';
import { PARADIS_MOBILE_PR_MERGE_CAPABILITY, PARADIS_MOBILE_PR_VIEW_CAPABILITY } from '../../common/paradisMobilePullRequest.js';
import { PARADIS_MOBILE_SCM_COMMIT_RECOVER_CAPABILITY, PARADIS_MOBILE_SCM_STAGE_FILE_CAPABILITY, PARADIS_MOBILE_SCM_SYNC_CAPABILITY } from '../../common/paradisMobileScmSync.js';

suite('ParadisMobileCompat', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('互換の窓: 旧版（minCompatible* 無し）は版の完全一致だけ、窓を知る版どうしは窓の中で話せる', () => {
		const cases: Array<[string, IParadisMobileCompatInput]> = [
			['旧アプリ × 今のPC', { mobileProtocolVersion: 3, mobileMinCompatiblePc: undefined, pcProtocolVersion: 3, pcMinCompatibleMobile: 3 }],
			['今のアプリ × 旧PC', { mobileProtocolVersion: 3, mobileMinCompatiblePc: 3, pcProtocolVersion: 3, pcMinCompatibleMobile: undefined }],
			['旧アプリ × 旧PC', { mobileProtocolVersion: 3, mobileMinCompatiblePc: undefined, pcProtocolVersion: 3, pcMinCompatibleMobile: undefined }],
			['将来のアプリ v4（PC v3 まで可） × 今のPC', { mobileProtocolVersion: 4, mobileMinCompatiblePc: 3, pcProtocolVersion: 3, pcMinCompatibleMobile: 3 }],
			['将来のアプリ v4 × 旧PC（完全一致しか受けない）', { mobileProtocolVersion: 4, mobileMinCompatiblePc: 3, pcProtocolVersion: 3, pcMinCompatibleMobile: undefined }],
			['将来のPC v4（アプリ v3 まで可） × 今のアプリ', { mobileProtocolVersion: 3, mobileMinCompatiblePc: 3, pcProtocolVersion: 4, pcMinCompatibleMobile: 3 }],
			['将来のPC v4（アプリ v3 まで可） × 旧アプリ', { mobileProtocolVersion: 3, mobileMinCompatiblePc: undefined, pcProtocolVersion: 4, pcMinCompatibleMobile: 3 }],
			['将来のPC v4 が v3 を切った × 今のアプリ', { mobileProtocolVersion: 3, mobileMinCompatiblePc: 3, pcProtocolVersion: 4, pcMinCompatibleMobile: 4 }],
			['将来のアプリ v5 が v3 のPCを切った × 今のPC', { mobileProtocolVersion: 5, mobileMinCompatiblePc: 5, pcProtocolVersion: 3, pcMinCompatibleMobile: 3 }],
			['版の読めないPC', { mobileProtocolVersion: 3, mobileMinCompatiblePc: 3, pcProtocolVersion: undefined, pcMinCompatibleMobile: undefined }],
			['版の読めない要求', { mobileProtocolVersion: 'x', mobileMinCompatiblePc: undefined, pcProtocolVersion: 3, pcMinCompatibleMobile: 3 }],
		];
		assert.deepStrictEqual(cases.map(([name, input]) => {
			const verdict = paradisEvaluateMobileCompat(input);
			return [name, verdict.kind === 'ok' ? `ok:v${verdict.wireVersion}` : verdict.reason];
		}), [
			['旧アプリ × 今のPC', 'ok:v3'],
			['今のアプリ × 旧PC', 'ok:v3'],
			['旧アプリ × 旧PC', 'ok:v3'],
			['将来のアプリ v4（PC v3 まで可） × 今のPC', 'ok:v3'],
			['将来のアプリ v4 × 旧PC（完全一致しか受けない）', 'pc-too-old'],
			['将来のPC v4（アプリ v3 まで可） × 今のアプリ', 'ok:v3'],
			['将来のPC v4（アプリ v3 まで可） × 旧アプリ', 'mobile-too-old'],
			['将来のPC v4 が v3 を切った × 今のアプリ', 'mobile-too-old'],
			['将来のアプリ v5 が v3 のPCを切った × 今のPC', 'pc-too-old'],
			['版の読めないPC', 'pc-too-old'],
			['版の読めない要求', 'mobile-too-old'],
		]);
	});

	test('capability: 形の合わない値と重複を捨て、広告の無い相手は何も持っていない扱い', () => {
		const parsed = paradisParseMobileCapabilities(['scm.push.v1', 'scm.push.v1', 'SCM.PUSH.V1', 'no-version', 42, 'term.sync.v2', `${'a'.repeat(70)}.v1`]);
		assert.deepStrictEqual({
			parsed,
			notArray: paradisParseMobileCapabilities('scm.push.v1'),
			has: paradisHasMobileCapability(parsed, 'scm.push.v1'),
			otherVersion: paradisHasMobileCapability(parsed, 'term.sync.v1'),
			legacyPeer: paradisHasMobileCapability(undefined, 'scm.push.v1'),
			ownListsAreWellFormed: [...PARADIS_MOBILE_PC_CAPABILITIES, ...PARADIS_MOBILE_APP_CAPABILITIES].every(name => paradisParseMobileCapabilities([name])?.[0] === name),
		}, {
			parsed: ['scm.push.v1', 'term.sync.v2'],
			notArray: undefined,
			has: true,
			otherVersion: false,
			legacyPeer: false,
			ownListsAreWellFormed: true,
		});
	});

	test('PC は W2-15（同期・コミットの立て直し・ファイルごとのステージ）と W2-36（PR の画面・マージ）を広告する', () => {
		assert.deepStrictEqual([
			PARADIS_MOBILE_SCM_SYNC_CAPABILITY,
			PARADIS_MOBILE_SCM_COMMIT_RECOVER_CAPABILITY,
			PARADIS_MOBILE_SCM_STAGE_FILE_CAPABILITY,
			PARADIS_MOBILE_PR_VIEW_CAPABILITY,
			PARADIS_MOBILE_PR_MERGE_CAPABILITY,
		].map(name => PARADIS_MOBILE_PC_CAPABILITIES.includes(name)), [true, true, true, true, true]);
	});

	test('個々の操作の版は窓の中（最低版〜自分の版）だけを受け付ける', () => {
		assert.deepStrictEqual([2, 3, 4, 5, '4', undefined].map(paradisIsAcceptedMobileWireVersion), [false, false, true, false, false, false]);
	});
});
