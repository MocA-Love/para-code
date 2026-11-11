/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isParadisSentryScrubbedWord } from '../../../sentry/common/paradisSentryDiagnostics.js';
import { paradisPtyHandoverSpans } from '../../common/paradisPtyHandover.js';
import { paradisPtyModeAttributes } from '../../common/paradisPtyModeDiagnostics.js';

suite('Para Code pty hosting mode diagnostics (Sentry)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('選んだ飼い方と 2 つの設定を、Sentry が消さない名前で載せる', () => {
		const attributes = [
			paradisPtyModeAttributes('daemon', 'none', { daemonEnabled: true, reattachAcrossUpdates: false }),
			paradisPtyModeAttributes('in_app', 'path_too_long', { daemonEnabled: false, reattachAcrossUpdates: true }),
		];
		assert.deepStrictEqual({
			attributes,
			scrubbed: attributes.flatMap(entry => Object.entries(entry)).filter(([key, value]) => isParadisSentryScrubbedWord(key) || (typeof value === 'string' && isParadisSentryScrubbedWord(value))),
		}, {
			attributes: [
				{ safe_pty_mode: 'daemon', safe_pty_fallback: 'none', safe_set_daemon_enabled: 'on', safe_set_reattach: 'off' },
				{ safe_pty_mode: 'in_app', safe_pty_fallback: 'path_too_long', safe_set_daemon_enabled: 'off', safe_set_reattach: 'on' },
			],
			scrubbed: [],
		});
	});

	test('引き継ぎの span に、引き継ぎの常駐に繋がっているかを載せる', () => {
		const reattach = { unchanged: 0, tail: 0, rebuild: 0, handedOff: 0, gone: 0, failed: 0, tailChars: 0, rebuildChars: 0, maxRebuildMs: 0, rebuildReasons: {} };
		const spans = [true, false].map(daemon => paradisPtyHandoverSpans({ protocolVersion: 1, platform: 'linux', daemon, foreignHeld: 0, adoptions: [], letGo: 1, letGoFailed: 0, reattach, spared: 0, finishedWhileAway: 0 }, false));
		assert.deepStrictEqual(spans.map(list => list.map(span => [span.operation, span.attributes.safe_daemon])), [[['reattach', true]], [['reattach', false]]]);
	});
});
