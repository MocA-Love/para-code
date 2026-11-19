/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisAntigravityBrainRoot, paradisAntigravityConversationIdFromTranscriptPath, paradisAntigravityTranscriptStartsAsChild, paradisIsAntigravityChildConversation, paradisReadAntigravityConversationLineage } from '../../node/paradisAntigravityHistory.js';

const nodeRequire = createRequire(import.meta.url);
const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const MISSING = '33333333-3333-4333-8333-333333333333';

suite('ParadisAntigravityHistory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	let root: string;
	setup(async () => { root = await fs.mkdtemp(join(tmpdir(), 'paradis-antigravity-history-')); });
	teardown(async () => { await fs.rm(root, { recursive: true, force: true }); });

	test('reads which conversations are children from the conversation list, without its text columns', () => {
		// agy 1.5.9 の conversation_summaries の列のうち、読むものと本文の列（中身は自作の偽物）
		const dbPath = join(root, 'conversation_summaries.db');
		const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
		const database = new DatabaseSync(dbPath);
		try {
			database.exec('PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF');
			database.exec('CREATE TABLE `conversation_summaries` (`conversation_id` text, `title` text NOT NULL DEFAULT "", `preview` text NOT NULL DEFAULT "", `parent_conversation_id` text NOT NULL DEFAULT "", `nesting_depth` integer NOT NULL DEFAULT 0, PRIMARY KEY (`conversation_id`))');
			const insert = database.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)');
			insert.run(PARENT, 'fake parent', 'fake preview', '', 0);
			insert.run(CHILD, 'fake child', 'fake preview', PARENT, 1);
		} finally {
			database.close();
		}
		const lineage = paradisReadAntigravityConversationLineage([PARENT, CHILD, MISSING, 'not-an-id'], dbPath);
		assert.deepStrictEqual({
			rows: Object.fromEntries(lineage),
			children: [...lineage].map(([id, value]) => [id, paradisIsAntigravityChildConversation(value)]),
		}, {
			rows: { [PARENT]: { parentId: undefined, nestingDepth: 0 }, [CHILD]: { parentId: PARENT, nestingDepth: 1 } },
			children: [[PARENT, false], [CHILD, true]],
		});
	});

	test('takes the conversation id from a transcript path, and tells a child conversation by its first line', async () => {
		const parent = join(root, 'parent.jsonl');
		const child = join(root, 'child.jsonl');
		const empty = join(root, 'empty.jsonl');
		await fs.writeFile(parent, `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>x</USER_REQUEST>' })}\n`);
		await fs.writeFile(child, `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', content: '<SYSTEM_MESSAGE>x</SYSTEM_MESSAGE>' })}\n`);
		await fs.writeFile(empty, '');
		assert.deepStrictEqual({
			id: paradisAntigravityConversationIdFromTranscriptPath(join(paradisAntigravityBrainRoot('/home/example'), PARENT, '.system_generated', 'logs', 'transcript_full.jsonl')),
			otherFile: paradisAntigravityConversationIdFromTranscriptPath(join(paradisAntigravityBrainRoot('/home/example'), PARENT, '.system_generated', 'logs', 'transcript.jsonl')),
			parent: await paradisAntigravityTranscriptStartsAsChild(parent),
			child: await paradisAntigravityTranscriptStartsAsChild(child),
			empty: await paradisAntigravityTranscriptStartsAsChild(empty),
			missing: await paradisAntigravityTranscriptStartsAsChild(join(root, 'missing.jsonl')),
		}, { id: PARENT, otherFile: undefined, parent: false, child: true, empty: undefined, missing: undefined });
	});
});
