/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_INSECURE_CONTEXT_MESSAGE, paradisReportInsecureContextSentinel } from '../../common/paradisInsecureContextSentinel.js';

suite('ParadisInsecureContextSentinel', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function run(isSecureContext: boolean, subtleCrypto: unknown, sentryId: string) {
		const reported: string[] = [];
		const logged: string[] = [];
		const outcome = paradisReportInsecureContextSentinel({
			isSecureContext,
			subtleCrypto,
			report: message => {
				reported.push(message);
				return sentryId;
			},
			log: message => logged.push(message),
		});
		return { outcome, reported, logged };
	}

	const SUBTLE = {};

	test('stays quiet while the renderer is a secure context with subtle crypto', () => {
		assert.deepStrictEqual(run(true, SUBTLE, 'event-id'), {
			outcome: 'none',
			reported: [],
			logged: [],
		});
	});

	test('reports through Sentry for every way the secure context can be lost', () => {
		// isSecureContext が落ちる場合と、subtle だけが消える場合の両方で webview は mount できない。
		assert.deepStrictEqual({
			insecure: run(false, SUBTLE, 'event-id'),
			noSubtle: run(true, undefined, 'event-id'),
			neither: run(false, undefined, 'event-id'),
		}, {
			insecure: { outcome: 'sentry', reported: [PARADIS_INSECURE_CONTEXT_MESSAGE], logged: [] },
			noSubtle: { outcome: 'sentry', reported: [PARADIS_INSECURE_CONTEXT_MESSAGE], logged: [] },
			neither: { outcome: 'sentry', reported: [PARADIS_INSECURE_CONTEXT_MESSAGE], logged: [] },
		});
	});

	test('falls back to the console when Sentry never initialized', () => {
		// Sentry が立ち上がっていないと capture は空の id を返して黙る。**そこで消えるのが
		// この sentinel にとって最悪の結果**なので、必ずどこかに痕跡を残す。
		assert.deepStrictEqual(run(false, undefined, ''), {
			outcome: 'console',
			reported: [PARADIS_INSECURE_CONTEXT_MESSAGE],
			logged: [`[Para Code] ${PARADIS_INSECURE_CONTEXT_MESSAGE}`],
		});
	});

	test('does not touch Sentry or the console for a healthy renderer even when Sentry is down', () => {
		assert.deepStrictEqual(run(true, SUBTLE, ''), {
			outcome: 'none',
			reported: [],
			logged: [],
		});
	});
});
