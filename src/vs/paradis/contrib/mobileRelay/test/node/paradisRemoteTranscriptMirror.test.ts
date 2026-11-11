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
import { PARADIS_REMOTE_TRANSCRIPT_MIRROR_UNAVAILABLE, ParadisRemoteTranscriptMirrorStore, paradisIsRemoteAgentTranscriptMirrorPath, paradisIsRemoteAgentTranscriptPath, paradisRemoteTranscriptCatchUpEnd, paradisRemoteTranscriptCopyState, paradisRemoteTranscriptMirrorPathFor, paradisRemoteTranscriptMirrorRoots } from '../../node/paradisRemoteTranscriptMirror.js';

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
			// 印の無い hook（手元、または印を持たない旧版のスクリプトが残っている接続先）は、
			// 従来どおり綴りで見分ける。手元のホーム配下はそのまま読めるので写さない
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

	test('trusts the host marker over the spelling of the path', () => {
		// 手元と接続先でユーザー名が同じ構成（Linux から同名ユーザーのサーバーへ ssh する等）では、
		// 接続先の transcript が手元のホームと同じ綴りになる。綴りだけで見分けていた頃は、これが
		// 手元のものと判定されて写しが作られず、会話がモバイルにも詳細画面にも一切出なかった。
		// 手元のホームは環境変数で決まるので、走らせるOSに依らないよう固定して確かめる
		const previousHome = process.env['CLAUDE_CONFIG_DIR'];
		process.env['CLAUDE_CONFIG_DIR'] = '/home/alice/.claude';
		try {
			const sameSpellingAsLocal = '/home/alice/.claude/projects/-srv-app/9d1f.jsonl';
			assert.deepStrictEqual([
				paradisIsRemoteAgentTranscriptPath(sameSpellingAsLocal, 'ssh-remote-server'),
				// 印が無ければ従来どおり。手元のホーム配下はそのまま読めるので写さない
				paradisIsRemoteAgentTranscriptPath(sameSpellingAsLocal),
				// 印があっても、写し先を組み立てる前の字面の確認はそのまま通す
				paradisIsRemoteAgentTranscriptPath('/home/alice/.claude/projects/../../../etc/shadow.jsonl', 'ssh-remote-server'),
				paradisIsRemoteAgentTranscriptPath('/home/alice/notes/a.jsonl', 'ssh-remote-server'),
				// 形の違う印は名乗りとして受けない（従来どおり綴りで見分ける）
				paradisIsRemoteAgentTranscriptPath(sameSpellingAsLocal, 'ssh remote/server'),
			], [true, false, false, false, false]);
		} finally {
			if (previousHome === undefined) {
				delete process.env['CLAUDE_CONFIG_DIR'];
			} else {
				process.env['CLAUDE_CONFIG_DIR'] = previousHome;
			}
		}
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
			// 自分で書いた写しを弾いてしまう。実体を辿った綴りも許可 root に入れておく。
			// 置き場を作るのは台帳側の非同期処理なので、実体を辿れるようになるまで待つ
			// （待たずに realpath すると ENOENT で落ちることがある）
			const deadline = Date.now() + 2_000;
			let real = '';
			while (Date.now() < deadline) {
				real = await fs.realpath(root).catch(() => '');
				if (real.length > 0 && paradisRemoteTranscriptMirrorRoots().includes(real)) {
					break;
				}
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
			// 写し置き場の中だと見分けられることが、shared process が上がり直して hook の印を
			// 失った後に「これは接続先のセッション」と分かる唯一の手掛かりになる
			assert.deepStrictEqual(
				[paradisIsRemoteAgentTranscriptMirrorPath(localPath), paradisIsRemoteAgentTranscriptMirrorPath(REMOTE_PATH)],
				[true, false],
			);

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

	test('names the window that copies a transcript, so the shell output of that conversation is read through it', async () => {
		await withStore(async store => {
			const localPath = store.localPathForHookPath(REMOTE_PATH, 'pane-1')!;
			const before = store.ownerForLocalPath(localPath);
			await store.begin('window-a', REMOTE_PATH);
			const owned = store.ownerForLocalPath(localPath);
			const other = store.ownerForLocalPath(join(store.mirrorRoot, 'elsewhere.jsonl'));
			store.release('window-a');
			assert.deepStrictEqual({ before, owned, other, released: store.ownerForLocalPath(localPath) }, { before: undefined, owned: 'window-a', other: undefined, released: undefined });
		});
	});

	test('takes the copy again after a restart instead of guessing where the old one ended on the host', async () => {
		// 写しは接続先の末尾の窓のことがある。立て直した shared process は写しの先頭が接続先のどこかを知らないので、
		// 写しの大きさを接続先の位置とみなして続けると中身が混ざる。一から取り直し、tailer には作り直しを伝える
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		try {
			const first = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService());
			const localPath = first.localPathForHookPath(REMOTE_PATH, 'pane-1')!;
			await first.begin('window-a', REMOTE_PATH);
			await first.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n'));
			first.dispose();

			const second = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService());
			second.localPathForHookPath(REMOTE_PATH, 'pane-1');
			const begun = await second.begin('window-a', REMOTE_PATH, 8);
			const caughtUp = await second.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n'), true);
			assert.deepStrictEqual({
				begun, caughtUp,
				content: await fs.readFile(localPath, 'utf8'),
				replaced: (paradisRemoteTranscriptCopyState(localPath)?.generation ?? 0) > 0,
				// 取り直した分は過去の会話（読み手は鳴らさない）
				catchUpEnd: paradisRemoteTranscriptCatchUpEnd(localPath),
			}, { begun: 0, caughtUp: 8, content: '{"a":1}\n', replaced: true, catchUpEnd: 8 });
			second.dispose();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('starts a large host transcript from a window at its end, aligned to a line', async () => {
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		const store = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService(), 64, 16);
		try {
			const localPath = store.localPathForHookPath(REMOTE_PATH, 'pane-1')!;
			const host = '{"old":"aaaaaaaa"}\n{"mid":"bbbb"}\n{"new":1}\n';
			// 窓の始まり（末尾から 16 バイト手前）は行の途中。そこから読んで、最初の改行の後から写す
			const begun = await store.begin('window-a', REMOTE_PATH, host.length);
			const next = await store.append('window-a', REMOTE_PATH, Buffer.from(host.slice(begun)), true);
			const later = await store.append('window-a', REMOTE_PATH, Buffer.from('{"later":2}\n'));
			assert.deepStrictEqual({
				begun, next, later,
				content: await fs.readFile(localPath, 'utf8'),
				state: paradisRemoteTranscriptCopyState(localPath),
				listed: store.list('window-a'),
			}, {
				begun: host.length - 16, next: host.length, later: host.length + 12,
				content: '{"new":1}\n{"later":2}\n',
				state: { generation: 0, partial: true },
				listed: [REMOTE_PATH],
			});
		} finally {
			store.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('keeps the first line of a large Codex rollout, then copies the window at its end', async () => {
		// Codex は先頭行（session_meta）で素性（root / SubAgent）を見分けるので、窓にしても先頭行は残す
		const codexPath = '/home/other/.codex/sessions/2026/11/11/rollout-2026-11-11T00-00-00-a.jsonl';
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		const store = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService(), 64, 16);
		try {
			const localPath = store.localPathForHookPath(codexPath, 'pane-1')!;
			const host = '{"type":"session_meta"}\n{"old":"aaaaaaaaaaaa"}\n{"mid":"b"}\n{"new":1}\n';
			const begun = await store.begin('window-a', codexPath, host.length);
			const jumped = await store.append('window-a', codexPath, Buffer.from(host.slice(begun, begun + 30)), true);
			const next = await store.append('window-a', codexPath, Buffer.from(host.slice(jumped)), true);
			assert.deepStrictEqual({
				begun, jumped, next,
				content: await fs.readFile(localPath, 'utf8'),
			}, {
				begun: 0, jumped: host.length - 16, next: host.length,
				content: '{"type":"session_meta"}\n{"new":1}\n',
			});
		} finally {
			store.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('keeps the latest window of a copy that reaches its size limit, and keeps following', async () => {
		// 上限で止めると、以後は二度と写されず会話が過去のまま固まる。手元の末尾で作り直して続ける
		const dir = await fs.mkdtemp(join(tmpdir(), 'paradis-remote-transcript-'));
		const store = new ParadisRemoteTranscriptMirrorStore(dir, new NullLogService(), 24, 12);
		try {
			const localPath = store.localPathForHookPath(REMOTE_PATH, 'pane-1')!;
			assert.strictEqual(await store.begin('window-a', REMOTE_PATH, 0), 0);
			const positions = [
				await store.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n')),
				await store.append('window-a', REMOTE_PATH, Buffer.from('{"b":2}\n')),
				await store.append('window-a', REMOTE_PATH, Buffer.from('{"c":3}\n')),
				await store.append('window-a', REMOTE_PATH, Buffer.from('{"d":4}\n')),
			];
			const content = await fs.readFile(localPath, 'utf8');
			const state = paradisRemoteTranscriptCopyState(localPath);
			const listed = store.list('window-a');
			// 書きかけは残さない
			const leftovers = (await fs.readdir(join(localPath, '..'))).filter(name => name !== '9d1f.jsonl');
			// 作り直した後に担当を取り直しても、接続先の続きの位置が返る
			store.release('window-a');
			const again = await store.begin('window-b', REMOTE_PATH, 32);
			assert.deepStrictEqual({ positions, content, state, listed, leftovers, again }, {
				positions: [8, 16, 24, 32],
				content: '{"c":3}\n{"d":4}\n',
				state: { generation: 1, partial: true },
				listed: [REMOTE_PATH],
				leftovers: [],
				again: 32,
			});
		} finally {
			store.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('marks a copy as stalled while the host transcript cannot be read, and clears it once it can', async () => {
		await withStore(async store => {
			const localPath = store.localPathForHookPath(REMOTE_PATH, 'pane-1')!;
			const changes: string[] = [];
			const listener = store.onDidChangeStalled(path => changes.push(path));
			try {
				await store.begin('window-a', REMOTE_PATH);
				store.reportReadFailure('window-b', REMOTE_PATH, true); // 担当ではないウィンドウの知らせは聞かない
				const otherWindow = store.isStalled(localPath);
				store.reportReadFailure('window-a', REMOTE_PATH, true);
				const failed = store.isStalled(localPath);
				store.reportReadFailure('window-a', REMOTE_PATH, false);
				assert.deepStrictEqual({ otherWindow, failed, recovered: store.isStalled(localPath), changes }, { otherWindow: false, failed: true, recovered: false, changes: [localPath, localPath] });
			} finally {
				listener.dispose();
			}
		});
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

	test('keeps the copy on disk after it stops following, so a parked pane resumes', async () => {
		await withStore(async store => {
			// 追いかけるのをやめる猶予は10分だが、退避したペインが戻ってくる猶予は7日ある。
			// ここで消すと、15分後に戻したペインの会話が空になり、次のhookで接続先の
			// transcript を末尾の窓から取り直す
			const localPath = store.localPathForHookPath(REMOTE_PATH, 'pane-1')!;
			await store.begin('window-a', REMOTE_PATH);
			await store.append('window-a', REMOTE_PATH, Buffer.from('{"a":1}\n'));

			const clock = sinon.useFakeTimers({ now: Date.now() + 11 * 60_000 });
			try {
				store.retainLiveTokens(() => false);
			} finally {
				clock.restore();
			}
			// 接続先を読みに行くのはやめる（一覧から消える）が、写しはそのまま残す
			assert.deepStrictEqual(store.list('window-a'), []);
			assert.strictEqual(await fs.readFile(localPath, 'utf8'), '{"a":1}\n');

			// ペインが戻ってきたら、写しの続きから再開する（先頭から取り直さない）
			store.localPathForHookPath(REMOTE_PATH, 'pane-1');
			assert.strictEqual(await store.begin('window-a', REMOTE_PATH), 8);
		});
	});
});
