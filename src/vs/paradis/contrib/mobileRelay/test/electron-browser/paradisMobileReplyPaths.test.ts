/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ParadisMobileWorkspaceProvider } from '../../electron-browser/paradisMobileWorkspaceProvider.js';
import { Channels } from '../../common/paradisMobileProtocol.js';

interface IReplyPathsFixture {
	handleFsInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void>;
	handleScmInbound(payload: VSBuffer, mobileId: string | undefined): Promise<void>;
	findWsRoot(ws: string): URI | undefined;
	wsNotifyName(ws: string): string | undefined;
}

interface ISentFrame {
	readonly ch: number;
	readonly mobileId: string | undefined;
	readonly body: string;
}

/** scm・fs の応答の出口と、ワークスペースに紐付かない閲覧用のデータの返し方を固定する。 */
suite('ParadisMobileWorkspaceProvider reply paths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const worktreeUri = URI.file('/repo-a.worktrees/feature');
	const worktreeKey = `worktree:${worktreeUri.toString()}`;

	function createFixture(fail: boolean): { fixture: IReplyPathsFixture; frames: ISentFrame[]; calls: string[] } {
		const frames: ISentFrame[] = [];
		const calls: string[] = [];
		const fetcher = (name: string) => async (...args: unknown[]) => {
			calls.push(`${name}(${JSON.stringify(args)})`);
			if (fail) {
				throw new Error(`${name} failed`);
			}
			return { from: name };
		};
		const fixture = Object.assign(Object.create(ParadisMobileWorkspaceProvider.prototype) as object, {
			sendFrame: (frame: { ch: number; mobileId?: string; payload: VSBuffer }) => frames.push({ ch: frame.ch, mobileId: frame.mobileId, body: frame.payload.toString() }),
			fetchUsageDashboard: fetcher('usage'),
			fetchRtkSavings: fetcher('rtk'),
			fetchLimitsSnapshot: fetcher('limits'),
			fetchGithubMetrics: fetcher('github'),
			fetchResourceReport: fetcher('sysres'),
			fetchSpaceDisk: fetcher('spacedisk'),
			getWorktreeCreateForm: async (options: unknown) => {
				calls.push(`form(${JSON.stringify(options)})`);
				if (fail) {
					throw new Error('form failed');
				}
				return { repos: ['a'] };
			},
			workspaceSwitchService: { repositories: [{ id: 'repo-a', name: 'Repo A', uri: URI.file('/repo-a') }, { id: 'repo-b', name: 'Repo B', uri: URI.file('/repo-b') }] },
			worktreeService: { getWorktrees: (id: string) => id === 'repo-b' ? [{ uri: worktreeUri, name: 'feature', missing: true }] : [] },
		}) as unknown as IReplyPathsFixture;
		return { fixture, frames, calls };
	}

	const request = (body: object) => VSBuffer.fromString(JSON.stringify(body));

	async function runHostData(fail: boolean): Promise<{ frames: ISentFrame[]; calls: string[] }> {
		const { fixture, frames, calls } = createFixture(fail);
		await fixture.handleFsInbound(request({ t: 'usage', id: 'r1', bypassCache: true }), 'mobile-1');
		await fixture.handleFsInbound(request({ t: 'rtk', id: 'r2' }), 'mobile-1');
		await fixture.handleFsInbound(request({ t: 'limits', id: 'r3' }), 'mobile-1');
		await fixture.handleFsInbound(request({ t: 'github', id: 'r4' }), 'mobile-1');
		await fixture.handleFsInbound(request({ t: 'sysres', id: 'r5', history: 'h' }), 'mobile-1');
		await fixture.handleFsInbound(request({ t: 'spacedisk', id: 'r6' }), undefined);
		return { frames, calls };
	}

	test('閲覧用のデータ 6 種類は、取れたら { id, t, data } を返す', async () => {
		const { frames, calls } = await runHostData(false);
		assert.deepStrictEqual({ frames, calls }, {
			frames: [
				{ ch: Channels.Fs, mobileId: 'mobile-1', body: '{"id":"r1","t":"usage","data":{"from":"usage"}}' },
				{ ch: Channels.Fs, mobileId: 'mobile-1', body: '{"id":"r2","t":"rtk","data":{"from":"rtk"}}' },
				{ ch: Channels.Fs, mobileId: 'mobile-1', body: '{"id":"r3","t":"limits","data":{"from":"limits"}}' },
				{ ch: Channels.Fs, mobileId: 'mobile-1', body: '{"id":"r4","t":"github","data":{"from":"github"}}' },
				{ ch: Channels.Fs, mobileId: 'mobile-1', body: '{"id":"r5","t":"sysres","data":{"from":"sysres"}}' },
				{ ch: Channels.Fs, mobileId: undefined, body: '{"id":"r6","t":"spacedisk","data":{"from":"spacedisk"}}' },
			],
			calls: ['usage([true])', 'rtk([false])', 'limits([false,true])', 'github([false])', 'sysres([false,"h"])', 'spacedisk([false])'],
		});
	});

	test('閲覧用のデータ 6 種類は、失敗したら { id, error } を返す', async () => {
		const { frames } = await runHostData(true);
		assert.deepStrictEqual(frames.map(frame => frame.body), [
			'{"id":"r1","error":"Error: usage failed"}',
			'{"id":"r2","error":"Error: rtk failed"}',
			'{"id":"r3","error":"Error: limits failed"}',
			'{"id":"r4","error":"Error: github failed"}',
			'{"id":"r5","error":"Error: sysres failed"}',
			'{"id":"r6","error":"Error: spacedisk failed"}',
		]);
	});

	test('scm の応答は scm のチャネルへ { id, ... } で返す', async () => {
		const { fixture, frames, calls } = createFixture(false);
		await fixture.handleScmInbound(request({ t: 'worktreeForm', id: 's1', agentsOnly: true }), 'mobile-1');
		await fixture.handleScmInbound(request({ t: 'createWorktree', id: 's2' }), '');
		await fixture.handleScmInbound(VSBuffer.fromString('not json'), 'mobile-1');
		assert.deepStrictEqual({ frames, calls }, {
			frames: [
				{ ch: Channels.Scm, mobileId: 'mobile-1', body: '{"id":"s1","t":"worktreeForm","repos":["a"]}' },
				{ ch: Channels.Scm, mobileId: undefined, body: '{"id":"s2","error":"repo is required"}' },
			],
			calls: ['form({"agentsOnly":true})'],
		});
	});

	test('状態キーからルートと通知の名前を引く（worktree は PC に無いものも含む）', () => {
		const { fixture } = createFixture(false);
		assert.deepStrictEqual({
			roots: ['repo-a', worktreeKey, 'worktree:file:///nowhere', 'unknown'].map(ws => fixture.findWsRoot(ws)?.toString()),
			names: ['repo-b', worktreeKey, 'worktree:file:///nowhere', 'unknown'].map(ws => fixture.wsNotifyName(ws)),
		}, {
			roots: ['file:///repo-a', 'file:///repo-a.worktrees/feature', undefined, undefined],
			names: ['Repo B', 'feature', undefined, undefined],
		});
	});
});
