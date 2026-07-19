/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PARADIS_AGENT_LIVE_APPEND_ENCODING, paradisAgentLivePayloadForEncoding, paradisCreateAgentLiveAppendPatch } from '../../common/paradisMobileAgentLivePatch.js';

suite('ParadisMobileAgentLivePatch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('creates an exact revision-guarded append for a growing Unicode message', () => {
		const previousText = '日本語🙂'.repeat(100);
		const append = '\n続きです';
		const previous = { phase: 'message' as const, source: 'hook' as const, startedAt: 10, updatedAt: 20, text: previousText };
		const current = { ...previous, updatedAt: 30, text: previousText + append, final: true as const };

		assert.strictEqual(PARADIS_AGENT_LIVE_APPEND_ENCODING, 'agent-live-append-v1');
		assert.deepStrictEqual(paradisCreateAgentLiveAppendPatch(previous, current, 7, 8), {
			baseRevision: 7,
			revision: 8,
			source: 'hook',
			startedAt: 10,
			updatedAt: 30,
			append,
			final: true,
		});
	});

	test('uses a patch for a final-only update when it is smaller than the full live state', () => {
		const text = 'generated '.repeat(200);
		const previous = { phase: 'message' as const, source: 'codex-daemon' as const, startedAt: 10, updatedAt: 20, text };
		const current = { ...previous, updatedAt: 30, final: true as const };

		assert.deepStrictEqual(paradisCreateAgentLiveAppendPatch(previous, current, 2, 3), {
			baseRevision: 2,
			revision: 3,
			source: 'codex-daemon',
			startedAt: 10,
			updatedAt: 30,
			append: '',
			final: true,
		});
	});

	test('falls back for replacement, identity changes, invalid revisions, and size regressions', () => {
		const previous = { phase: 'message' as const, source: 'hook' as const, startedAt: 10, updatedAt: 20, text: 'prefix' };
		assert.strictEqual(paradisCreateAgentLiveAppendPatch(previous, { ...previous, updatedAt: 30, text: 'replacement' }, 1, 2), undefined);
		assert.strictEqual(paradisCreateAgentLiveAppendPatch(previous, { ...previous, source: 'codex-daemon', updatedAt: 30, text: 'prefix-more' }, 1, 2), undefined);
		assert.strictEqual(paradisCreateAgentLiveAppendPatch(previous, { ...previous, updatedAt: 30, text: 'prefix-more' }, 2, 2), undefined);
		assert.strictEqual(paradisCreateAgentLiveAppendPatch(previous, { ...previous, updatedAt: 30, text: 'prefix-more' }, 1, 3), undefined);
		const empty = { phase: 'message' as const, source: 'hook' as const, startedAt: 10, updatedAt: 20 };
		assert.strictEqual(paradisCreateAgentLiveAppendPatch(empty, { ...empty, updatedAt: 30, text: 'x' }, 1, 2), undefined);
	});

	test('selects append only for exact negotiation and preserves full live otherwise', () => {
		const previous = { phase: 'message' as const, source: 'hook' as const, startedAt: 10, updatedAt: 20, text: 'a'.repeat(1_000) };
		const current = { ...previous, updatedAt: 30, text: `${previous.text}続き` };
		const negotiated = paradisAgentLivePayloadForEncoding(PARADIS_AGENT_LIVE_APPEND_ENCODING, previous, current, 4, 5);
		const negotiatedAppend = (negotiated as { readonly liveAppend?: { readonly append: string } }).liveAppend;
		assert.notStrictEqual(negotiatedAppend, undefined);
		assert.strictEqual(negotiatedAppend?.append, '続き');
		assert.deepStrictEqual(paradisAgentLivePayloadForEncoding(undefined, previous, current, 4, 5), { live: current, liveRevision: 5 });
		assert.deepStrictEqual(paradisAgentLivePayloadForEncoding('agent-live-append-v2', previous, current, 4, 5), { live: current, liveRevision: 5 });
	});

	test('substantially reduces a representative streaming message while preserving every revision', () => {
		const encoder = new TextEncoder();
		let previous: { phase: 'message'; source: 'codex-daemon'; startedAt: number; updatedAt: number; text: string } | undefined;
		let fullBytes = 0;
		let negotiatedBytes = 0;
		for (let revision = 1; revision <= 60; revision++) {
			const current = { phase: 'message' as const, source: 'codex-daemon' as const, startedAt: 10, updatedAt: 10 + revision, text: (previous?.text ?? '') + '日本語🙂'.repeat(25) };
			const full = { t: 'delta', id: 7, agent: 'codex', epoch: 'e1', rev: 1, messages: [], live: current, liveRevision: revision };
			const selected = { t: 'delta', id: 7, agent: 'codex', epoch: 'e1', rev: 1, messages: [], ...paradisAgentLivePayloadForEncoding(PARADIS_AGENT_LIVE_APPEND_ENCODING, previous, current, revision - 1, revision) };
			fullBytes += encoder.encode(JSON.stringify(full)).byteLength;
			negotiatedBytes += encoder.encode(JSON.stringify(selected)).byteLength;
			previous = current;
		}
		assert.ok(negotiatedBytes < fullBytes * 0.15, `expected negotiated=${negotiatedBytes} to be under 15% of full=${fullBytes}`);
	});
});
