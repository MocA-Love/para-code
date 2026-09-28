/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { createRequire } from 'module';
import type * as SentryUtility from '@sentry/electron/utility';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDedupeFingerprint, paradisSafeErrorTags, toParadisSentrySafeError } from '../../common/paradisSentryDiagnostics.js';

type DedupeArgs = Parameters<NonNullable<ReturnType<typeof SentryUtility.dedupeIntegration>['processEvent']>>;

/**
 * Runs explicit reports through the SDK's real Dedupe integration, shaped as the SDK hands them to it:
 * the safe error's type and value, its frames, and the capture context's fingerprint.
 */
suite('ParadisSentryDedupe', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function survivors(errors: readonly Error[]): Promise<number> {
		// The unit-test import map only knows package roots, not the `/utility` subpath, so load the
		// SDK through Node's resolver.
		const { dedupeIntegration } = createRequire(import.meta.url)('@sentry/electron/utility') as typeof SentryUtility;
		const dedupe = dedupeIntegration();
		let kept = 0;
		for (const error of errors) {
			const safe = toParadisSentrySafeError('unhandled-error', 'on-unexpected-error', error);
			const event: DedupeArgs[0] = {
				exception: { values: [{ type: safe.name, value: safe.message }] },
				fingerprint: paradisDedupeFingerprint(paradisSafeErrorTags(error)),
			};
			if (await dedupe.processEvent?.(event, {} as DedupeArgs[1], {} as DedupeArgs[2])) {
				kept++;
			}
		}
		return kept;
	}

	test('lets different frame-less errors through and still drops a true repeat', async () => {
		const stackless = (message: string) => Object.assign(new Error(message), { stack: `Error: ${message}` });
		assert.deepStrictEqual({
			different: await survivors([stackless('Channel has been closed'), stackless('Unknown channel')]),
			repeated: await survivors([stackless('Channel has been closed'), stackless('Channel has been closed')]),
			sameShapeOtherPath: await survivors([stackless(`Cannot open '/Users/a/x'`), stackless(`Cannot open '/Users/b/y'`)]),
		}, {
			different: 2,
			repeated: 1,
			sameShapeOtherPath: 1,
		});
	});
});
