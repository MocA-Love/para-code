/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { PARADIS_HIBERNATION_REFUSAL_WORDS, PARADIS_HIBERNATION_RESUME_WORDS, paradisHibernationAttemptAttributes, paradisHibernationRefusalWord, paradisHibernationResumeAttributes } from '../../common/paradisAgentHibernationDiagnostics.js';

suite('Para Code agent hibernation diagnostics (Sentry)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const settings = { enabled: true, idleMinutes: 30 };

	test('休止と再開の値の形', () => {
		assert.deepStrictEqual([
			paradisHibernationAttemptAttributes('ok', settings, 1_812_345.6, { killed: false, bypass: true }),
			paradisHibernationAttemptAttributes(paradisHibernationRefusalWord('no-session'), settings, undefined),
			paradisHibernationResumeAttributes('no-shell-integration', 'mobile', { enabled: false, idleMinutes: 5 }, 60_000, 3),
			paradisHibernationResumeAttributes('error', 'visible', settings, undefined, 0),
		], [
			{ safe_set_enabled: 'on', safe_set_idle_minutes: 30, safe_outcome: 'ok', safe_idle_ms: 1_812_346, safe_sigkill: false, safe_bypass: true },
			{ safe_set_enabled: 'on', safe_set_idle_minutes: 30, safe_outcome: 'no_conversation', safe_idle_ms: -1 },
			{ safe_set_enabled: 'off', safe_set_idle_minutes: 5, safe_outcome: 'no_shell_integration', safe_trigger: 'mobile', safe_hibernated_ms: 60_000, safe_inputs_while_hibernated: 3 },
			{ safe_set_enabled: 'on', safe_set_idle_minutes: 30, safe_outcome: 'error', safe_trigger: 'visible', safe_hibernated_ms: -1, safe_inputs_while_hibernated: 0 },
		]);
	});

	test('キーにも理由の語にも、Sentry が消す語を入れない', () => {
		const keys = [
			...Object.keys(paradisHibernationAttemptAttributes('ok', settings, 1, { killed: true, bypass: true })),
			...Object.keys(paradisHibernationResumeAttributes('sent', 'visible', settings, 1, 1)),
		];
		const words = [...PARADIS_HIBERNATION_REFUSAL_WORDS, ...PARADIS_HIBERNATION_RESUME_WORDS, 'ok', 'no_ledger', 'ipc_failed', 'visible', 'mobile'];
		assert.deepStrictEqual([...keys, ...words].filter(isParadisSentryScrubbedWord), []);
	});
});
