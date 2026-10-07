/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisBeginFolderUpdateTrace, paradisCountFileChannel, paradisMarkFolderUpdate, paradisNoteFolderUpdateShortcut, paradisNoteParkedFolderConfiguration, paradisOverrideFolderUpdateTraceClockForTest, paradisSafeSwitchAttributes } from '../../common/paradisFolderUpdateTrace.js';

suite('ParadisFolderUpdateTrace', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let now = 0;
	let restoreClock: { dispose(): void };
	setup(() => {
		now = 1_000;
		restoreClock = paradisOverrideFolderUpdateTraceClockForTest(() => now);
	});
	teardown(() => restoreClock.dispose());

	test('splits update_folders_write at the upstream marks, in order, and ignores marks outside a trace', () => {
		// 記録していないときの境目と印は何も残さない。
		paradisMarkFolderUpdate('entered');
		paradisNoteFolderUpdateShortcut('resolve_conflict');
		const trace = paradisBeginFolderUpdateTrace();
		now += 3; paradisMarkFolderUpdate('entered');
		now += 5; paradisMarkFolderUpdate('set_folders');
		// 接続先の変更通知から走った別経路の `validated` は、`reloaded` より前なので捨てる。
		now += 1; paradisMarkFolderUpdate('validated');
		paradisNoteFolderUpdateShortcut('resolve_cached');
		now += 400; paradisMarkFolderUpdate('model_resolved');
		now += 900; paradisMarkFolderUpdate('saved');
		paradisNoteFolderUpdateShortcut('reload_cached');
		now += 300; paradisMarkFolderUpdate('reloaded');
		// 2 回目は捨てる。
		now += 10; paradisMarkFolderUpdate('reloaded');
		now += 2; paradisMarkFolderUpdate('validated');
		paradisNoteParkedFolderConfiguration();
		now += 7; paradisMarkFolderUpdate('folder_config_loaded');
		now += 1;
		const summary = trace.summarize(now);
		trace.end();
		paradisNoteParkedFolderConfiguration();
		assert.deepStrictEqual(summary, {
			safe_update_folders_queue_ms: 3,
			safe_update_folders_compose_ms: 5,
			safe_update_folders_resolve_ms: 401,
			safe_update_folders_save_ms: 900,
			safe_update_folders_reload_ms: 300,
			safe_update_folders_validate_ms: 12,
			safe_update_folders_folder_config_ms: 7,
			safe_update_folders_will_change_ms: 1,
			safe_update_folders_marks: 7,
			safe_update_folders_parked_configs: 1,
			safe_update_folders_resolve_cached: 1,
			safe_update_folders_resolve_verified: 0,
			safe_update_folders_resolve_conflict: 0,
			safe_update_folders_reload_cached: 1,
		});
	});

	test('drops the segments next to a missing mark instead of merging two segments into one', () => {
		const trace = paradisBeginFolderUpdateTrace();
		now += 3; paradisMarkFolderUpdate('entered');
		now += 5; paradisMarkFolderUpdate('set_folders');
		// `model_resolved` が来なかった (保存の前で失敗した)。以降の境目は順番の条件で受け取らない。
		now += 900; paradisMarkFolderUpdate('saved');
		const summary = trace.summarize(undefined);
		trace.end();
		assert.deepStrictEqual(summary, {
			safe_update_folders_queue_ms: 3,
			safe_update_folders_compose_ms: 5,
			safe_update_folders_marks: 2,
			safe_update_folders_parked_configs: 0,
			safe_update_folders_resolve_cached: 0,
			safe_update_folders_resolve_verified: 0,
			safe_update_folders_resolve_conflict: 0,
			safe_update_folders_reload_cached: 0,
		});
	});

	test('counts the file round trips of the traced window by kind, bytes and time, and passes calls through otherwise', async () => {
		const replies: Record<string, unknown> = {
			stat: { type: 1 },
			readFile: VSBuffer.fromString('{"folders":[]}'),
			writeFile: undefined,
			read: [VSBuffer.alloc(8), 5],
		};
		const delays: Record<string, number> = { stat: 40, readFile: 120, writeFile: 300, read: 60, watch: 0 };
		const channel: IChannel = {
			call: <T>(command: string) => {
				now += delays[command] ?? 0;
				return command === 'mkdir' ? Promise.reject(new Error('EEXIST')) : Promise.resolve(replies[command] as T);
			},
			listen: <T>() => Event.None as Event<T>,
		};
		const remote = paradisCountFileChannel(channel, 'remote');
		const workspaceFile = URI.file('/Users/example/secret-host/my-workspace.code-workspace');

		// 記録していないときは数えない。
		await remote.call('stat', [workspaceFile]);

		const trace = paradisBeginFolderUpdateTrace();
		await remote.call('stat', [workspaceFile]);
		await remote.call('readFile', [workspaceFile, {}]);
		await remote.call('writeFile', [workspaceFile, VSBuffer.fromString('{"folders":[{"path":"/x"}]}'), {}]);
		await remote.call('read', [3, 0, 8]);
		await remote.call('stat', [workspaceFile]);
		await remote.call('mkdir', [workspaceFile]).catch(() => undefined);
		remote.listen('readFileStream', [workspaceFile, {}]);
		const summary = trace.summarize(undefined);
		trace.end();
		await remote.call('stat', [workspaceFile]);

		assert.deepStrictEqual(summary, {
			safe_update_folders_marks: 0,
			safe_update_folders_parked_configs: 0,
			safe_update_folders_resolve_cached: 0,
			safe_update_folders_resolve_verified: 0,
			safe_update_folders_resolve_conflict: 0,
			safe_update_folders_reload_cached: 0,
			safe_update_folders_remote_calls: 7,
			safe_update_folders_remote_stats: 2,
			safe_update_folders_remote_reads: 3,
			safe_update_folders_remote_writes: 1,
			safe_update_folders_remote_others: 1,
			safe_update_folders_remote_read_bytes: 19,
			safe_update_folders_remote_write_bytes: 27,
			// stat 40 + readFile 120 + writeFile 300 + read 60 + stat 40 + mkdir 0。
			safe_update_folders_remote_wait_ms: 560,
			safe_update_folders_remote_max_ms: 300,
			// 最短の stat ＝ 1 往復の推定。
			safe_update_folders_remote_rtt_ms: 40,
		});
	});

	test('measures how long each call waited for its reply', async () => {
		let resolveStat: (value: unknown) => void = () => { };
		const channel: IChannel = {
			call: <T>() => new Promise<T>(resolve => { resolveStat = resolve as (value: unknown) => void; }),
			listen: <T>() => Event.None as Event<T>,
		};
		const local = paradisCountFileChannel(channel, 'local');
		const trace = paradisBeginFolderUpdateTrace();
		const pending = local.call('stat', [URI.file('/Users/example/repo')]);
		now += 250;
		resolveStat({ type: 2 });
		await pending;
		const summary = trace.summarize(undefined);
		trace.end();
		assert.deepStrictEqual({
			calls: summary.safe_update_folders_local_calls,
			wait: summary.safe_update_folders_local_wait_ms,
			rtt: summary.safe_update_folders_local_rtt_ms,
			remote: summary.safe_update_folders_remote_calls,
		}, { calls: 1, wait: 250, rtt: 250, remote: undefined });
	});

	test('sends only finite numbers under safe_ keys, never paths or names, and nothing Sentry would scrub', () => {
		assert.deepStrictEqual(paradisSafeSwitchAttributes({
			safe_update_folders_save_ms: 900,
			safe_busy_socket_ms: 120,
			safe_switch_file_events: 3,
			// 文字列は値でも通さない (パス・ホスト名・ワークスペース名)。
			safe_workspace_name: 'my-workspace',
			safe_remote_host: 'build-server.example.com',
			safe_path: '/Users/example/repo',
			// `safe_` で始まらない・記号を含むキー。
			update_folders_save_ms: 1,
			'safe_/Users/example': 1,
			// 部分一致でサーバ側に消される語。
			safe_terminal_ms: 1,
			safe_session_count: 1,
			safe_env_ms: 1,
			// 有限でない数。
			safe_nan_ms: Number.NaN,
			safe_inf_ms: Number.POSITIVE_INFINITY,
		}), {
			safe_update_folders_save_ms: 900,
			safe_busy_socket_ms: 120,
			safe_switch_file_events: 3,
		});
	});
});
