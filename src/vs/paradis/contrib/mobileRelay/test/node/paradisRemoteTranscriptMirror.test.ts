/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese test comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as sinon from 'sinon';
import { join } from '../../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { paradisClaudeConfigDir } from '../../../agentBrowser/node/paradisAgentHome.js';
import { PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE, ParadisRemoteTranscriptMirrorStore, paradisIsRemoteAgentTranscriptPath, paradisRemoteTranscriptMirrorPathFor, paradisRemoteTranscriptMirrorRoots } from '../../node/paradisRemoteTranscriptMirror.js';

const REMOTE_PATH = '/home/other/.claude/projects/-srv-app/9d1f.jsonl';

suite('ParadisRemoteTranscriptMirror', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	async function withStore(callback: (store: ParadisRemoteTranscriptMirrorStore, root: string) => Promise<void>): Promise<void> {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		const store = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService());
		try {
			await callback(store, store.mirrorRoot);
		} finally {
			store.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	}

	test('recognises only host transcripts that this machine cannot open itself', () => {
		assert.deepStrictEqual([
			paradisIsRemoteAgentTranscriptPath(REMOTE_PATH),
			paradisIsRemoteAgentTranscriptPath('/home/other/.codex/sessions/2026/08/12/rollout-1.jsonl'),
			// 手元のホーム配下はそのまま読めるので写さない（同じ機械へ ssh した場合も含む）
			paradisIsRemoteAgentTranscriptPath(join(paradisClaudeConfigDir(), 'projects', 'p', 'a.jsonl')),
			paradisIsRemoteAgentTranscriptPath('/home/other/.claude/projects/../../../etc/shadow.jsonl'),
			// Windows で動く shared process だと、この一片が写し置き場の外へ抜ける
			paradisIsRemoteAgentTranscriptPath('/home/other/.claude/projects/a\\..\\..\\..\\x.jsonl'),
			paradisIsRemoteAgentTranscriptPath('/home/other/.claude/projects/C:x/a.jsonl'),
			paradisIsRemoteAgentTranscriptPath('/home/other/notes/a.jsonl'),
			paradisIsRemoteAgentTranscriptPath('/home/other/.claude/projects/p/a.txt'),
			paradisIsRemoteAgentTranscriptPath('relative/.claude/a.jsonl'),
			paradisIsRemoteAgentTranscriptPath(undefined),
		], [true, true, false, false, false, false, false, false, false, false]);
	});

	test('keeps the directory layout so sibling lookups still work', () => {
		assert.strictEqual(
			paradisRemoteTranscriptMirrorPathFor('/data/mirror', REMOTE_PATH),
			join('/data/mirror', 'home', 'other', '.claude', 'projects', '-srv-app', '9d1f.jsonl'),
		);
		assert.strictEqual(paradisRemoteTranscriptMirrorPathFor('/data/mirror', '/home/other/notes/a.jsonl'), undefined);
	});

	test('registers the copy folder as it really is on disk', async () => {
		await withStore(async (store, root) => {
			// user-data が symlink 越しにあると（macOS の `/tmp` など）、字面だけの許可判定では
			// 自分で書いた写しを弾いてしまう。実体を辿った綴りも許可 root に入れておく
			const real = await fs.realpath(root);
			const deadline = Date.now() + 2_000;
			while (!paradisRemoteTranscriptMirrorRoots().includes(real) && Date.now() < deadline) {
				await new Promise<void>(resolve => setTimeout(resolve, 5));
			}
			const roots = paradisRemoteTranscriptMirrorRoots();
			assert.deepStrictEqual([roots.includes(root), roots.includes(real)], [true, true]);
		});
	});

	test('follows a host transcript and hands the copy to the reader', async () => {
		await withStore(async (store, root) => {
			const localPath = store.localPathForHookPath(REMOTE_PATH, 'pane-1');
			assert.strictEqual(localPath, join(root, 'home', 'other', '.claude', 'projects', '-srv-app', '9d1f.jsonl'));
			assert.deepStrictEqual(store.list('window-a'), [REMOTE_PATH]);

			assert.strictEqual(await store.begin('window-a', REMOTE_PATH), 0);
			assert.strictEqual(await store.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n')), 8);
			assert.strictEqual(await store.append('window-a', REMOTE_PATH, Buffer.from('{"b":2}\n')), 16);
			assert.strictEqual(await fs.readFile(localPath!, 'utf8'), '{"a":1}\n{"b":2}\n');

			// 別セッションに置き換わったら捨てて取り直す（読み手はサイズ減少で読み直す）
			assert.strictEqual(await store.reset('window-a', REMOTE_PATH), 0);
			assert.strictEqual(await fs.readFile(localPath!, 'utf8'), '');
		});
	});

	test('lets only one window write the copy, and frees it when that window goes away', async () => {
		await withStore(async store => {
			store.localPathForHookPath(REMOTE_PATH, 'pane-1');
			assert.strictEqual(await store.begin('window-a', REMOTE_PATH), 0);

			// 別のウィンドウは横取りできず、一覧にも出てこない
			assert.strictEqual(await store.begin('window-b', REMOTE_PATH), PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE);
			assert.strictEqual(await store.append('window-b', REMOTE_PATH, Buffer.from('x')), PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE);
			assert.deepStrictEqual(store.list('window-b'), []);

			store.release('window-a');
			assert.deepStrictEqual(store.list('window-b'), [REMOTE_PATH]);
			assert.strictEqual(await store.begin('window-b', REMOTE_PATH), 0);
		});
	});

	test('resumes from the end of an existing copy after a restart', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		try {
			const first = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService());
			first.localPathForHookPath(REMOTE_PATH, 'pane-1');
			await first.begin('window-a', REMOTE_PATH);
			await first.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n'));
			first.dispose();

			const second = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService());
			second.localPathForHookPath(REMOTE_PATH, 'pane-1');
			assert.strictEqual(await second.begin('window-a', REMOTE_PATH), 8);
			second.dispose();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('gives up on a copy that hits its size limit instead of re-reading it forever', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		const store = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService(), 8);
		try {
			store.localPathForHookPath(REMOTE_PATH, 'pane-1');
			assert.strictEqual(await store.begin('window-a', REMOTE_PATH), 0);
			assert.strictEqual(await store.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n')), 8);
			assert.strictEqual(await store.append('window-a', REMOTE_PATH, Buffer.from('{"b":2}\n')), PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE);

			// ここで一覧に出し続けると、担当ウィンドウが取り直しては読んで捨てる、を延々と繰り返す
			assert.deepStrictEqual(store.list('window-a'), []);
			assert.strictEqual(await store.begin('window-a', REMOTE_PATH), PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE);
		} finally {
			store.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('stops following transcripts whose pane is gone, but rides out a window reload', async () => {
		await withStore(async store => {
			store.localPathForHookPath(REMOTE_PATH, 'pane-1');

			// 再読み込み中はペインが一瞬見えなくなる。そこで落とすと会話が黙って止まる
			store.retainLiveTokens(() => false);
			assert.deepStrictEqual(store.list('window-a'), [REMOTE_PATH]);

			const clock = sinon.useFakeTimers({ now: Date.now() + 11 * 60_000 });
			try {
				store.retainLiveTokens(() => false);
			} finally {
				clock.restore();
			}
			assert.deepStrictEqual(store.list('window-a'), []);
		});
	});
});
