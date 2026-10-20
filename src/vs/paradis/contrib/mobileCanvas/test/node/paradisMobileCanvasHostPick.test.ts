/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisOrderMobileCanvasHostDirs, paradisPickMobileCanvasHost, paradisPickMobileCanvasHostAfterFailedStart } from '../../node/paradisMobileCanvasHostClient.js';

suite('ParadisMobileCanvasHostPick', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	interface ICandidate { readonly name: string; readonly dir: string; readonly version: string; readonly running: boolean; readonly metadata: undefined }

	function host(name: string, dir: string, version: string, running: boolean): ICandidate {
		return { name, dir, version, running, metadata: undefined };
	}

	function pick(candidates: ICandidate[], expected: string | undefined, knownBundledDir?: string): Promise<string | undefined> {
		return paradisPickMobileCanvasHost(candidates, expected, async candidate => candidate.running, knownBundledDir).then(found => found?.name);
	}

	test('host directories are ordered by protocol number, newest first', () => {
		assert.deepStrictEqual(paradisOrderMobileCanvasHostDirs(['v2', 'v10', 'tmp', 'v9', '.DS_Store']), ['v10', 'v9', 'v2', '.DS_Store', 'tmp']);
	});

	test('a stale record of another version does not hide the running host, and another protocol is never used', async () => {
		const staleNewer = host('stale', 'v3', '0.2.0', false);
		const ours = host('ours', 'v2', '0.1.16', true);
		const oursStopped = host('ours-stopped', 'v2', '0.1.16', false);
		// Each protocol directory holds one host.json, so another version in v2 replaces our record there.
		const sameProtocolOther = host('same-protocol', 'v2', '0.1.15', true);
		const olderProtocol = host('older-protocol', 'v1', '0.1.9', true);
		assert.deepStrictEqual({
			// The first record left behind by a host that is no longer running is skipped.
			skipsStale: await pick([staleNewer, ours], '0.1.16'),
			// A host of another protocol answers status but may speak another API: start the bundled one instead.
			neverOtherProtocol: await pick([staleNewer, oursStopped, olderProtocol], '0.1.16'),
			// Without knowing the bundled protocol, another version is not used either.
			unknownProtocol: await pick([staleNewer, sameProtocolOther, olderProtocol], '0.1.16'),
			// Once a host of the bundled version was found in v2, another version running there is fine.
			sameProtocolFallback: await pick([staleNewer, sameProtocolOther, olderProtocol], '0.1.16', 'v2'),
			anyVersionWhenUnknown: await pick([staleNewer, olderProtocol, ours], undefined),
		}, {
			skipsStale: 'ours',
			neverOtherProtocol: undefined,
			unknownProtocol: undefined,
			sameProtocolFallback: 'same-protocol',
			anyVersionWhenUnknown: 'older-protocol',
		});
	});

	test('when the bundled host does not start, the only running host is used, but not one of several', async () => {
		const after = (candidates: ICandidate[]) => paradisPickMobileCanvasHostAfterFailedStart(candidates, async candidate => candidate.running).then(found => found?.name);
		const stale = host('stale', 'v3', '0.2.0', false);
		const otherVersion = host('other-version', 'v2', '0.1.15', true);
		const olderProtocol = host('older-protocol', 'v1', '0.1.9', true);
		assert.deepStrictEqual({
			// Another extension's host holds the bundled protocol, so the bundled one refused to start.
			onlyOne: await after([stale, otherVersion]),
			ambiguous: await after([stale, otherVersion, olderProtocol]),
			none: await after([stale]),
		}, {
			onlyOne: 'other-version',
			ambiguous: undefined,
			none: undefined,
		});
	});
});
