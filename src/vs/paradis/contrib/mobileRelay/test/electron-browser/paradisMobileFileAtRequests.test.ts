/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import * as assert from 'assert';
import { decodeBase64, VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ISharedProcessService } from '../../../../../platform/ipc/electron-browser/services.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IRemoteAgentService } from '../../../../../workbench/services/remote/common/remoteAgentService.js';
import { IParadisGitResult } from '../../common/paradisMobileRelay.js';
import { paradisMobileRelativeSegments } from '../../electron-browser/paradisMobileFileAtRequests.js';
import { IParadisMobileRequestHost, paradisDispatchMobileRequest } from '../../electron-browser/paradisMobileRequestHandlers.js';
import { paradisMobileWordDiffDescriptor } from '../../electron-browser/paradisMobileWordDiffRequests.js';

const ROOT = URI.file('/repo');

suite('ParadisMobileFileAtRequests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** `HEAD:./a.md` のように、その側にあるパスだけを rev-parse が通す git の代わり。 */
	function git(present: readonly string[]) {
		const calls: string[] = [];
		return {
			calls,
			run: async (args: readonly string[]): Promise<IParadisGitResult> => {
				calls.push(args.join(' '));
				return { code: present.includes(args[args.length - 1]) ? 0 : 1, stdout: '', stderr: '' };
			},
		};
	}

	function createHost(present: readonly string[], sent: Uint8Array[], reads: string[]): IParadisMobileRequestHost {
		const fake = git(present);
		const services = new Map<unknown, unknown>([
			[IRemoteAgentService, { getConnection: () => null }],
			[IFileService, {
				readFile: async (uri: URI) => {
					reads.push(uri.toString(true));
					return { value: VSBuffer.fromString(`bytes of ${uri.path}`) };
				},
			}],
		]);
		return {
			invokeFunction: fn => fn({ get: id => services.get(id) ?? {} } as ServicesAccessor),
			resolveRoot: ws => ws === 'repo' ? ROOT : undefined,
			runGit: (_root, args) => fake.run(args),
			resolvePath: async (_ws, relativePath) => relativePath === 'gone.md' ? undefined : relativePath.length === 0 ? ROOT : URI.file(`/repo/${relativePath}`),
			getMobileCapabilities: async () => undefined,
			getMobileWireVersion: async () => undefined,
			send: (_channel, _mobileId, payload) => sent.push(payload),
		};
	}

	const flush = async () => {
		for (let turn = 0; turn < 10; turn++) {
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
	};

	test('rejects paths that leave the space or use another path syntax', () => {
		assert.deepStrictEqual(
			['docs/a.md', '../a', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', '', 'a//b/'].map(path => paradisMobileRelativeSegments(path)),
			[['docs', 'a.md'], undefined, undefined, undefined, undefined, undefined, undefined, ['a', 'b']],
		);
	});

	test('reads HEAD and the index through git: URIs, the working tree through the verified path, and reports a missing side', async () => {
		const sent: Uint8Array[] = [];
		const reads: string[] = [];
		const host = createHost(['HEAD:./docs/a.md', ':./docs/a.md'], sent, reads);
		const dispatch = (id: string, body: Record<string, unknown>) => paradisDispatchMobileRequest('scm', { t: 'fileAt', id, ws: 'repo', ...body }, 'phone', host);
		dispatch('head', { path: 'docs/a.md', side: 'head' });
		dispatch('index', { path: 'docs/a.md', side: 'index' });
		dispatch('new', { path: 'docs/new.md', side: 'head' });
		dispatch('wt', { path: 'docs/a.md', side: 'worktree', responseEncoding: 'fs-binary-v1' });
		dispatch('bad', { path: 'docs/a.md', side: 'tree' });
		dispatch('escape', { path: '../secret', side: 'head' });
		dispatch('outside', { path: 'gone.md', side: 'worktree' });
		await flush();
		const json = sent.filter(payload => payload[0] === 0x7b).map(payload => JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
		const binary = sent.filter(payload => payload[0] === 0x50);
		assert.deepStrictEqual({
			reads: [...reads].sort(),
			replies: json.map(reply => [reply.id, reply.missing ?? reply.error ?? new TextDecoder().decode(decodeBase64(String(reply.data)).buffer)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
			binary: binary.map(payload => String.fromCharCode(...payload.subarray(0, 3))),
		}, {
			reads: [
				'file:///repo/docs/a.md',
				'git:/repo/docs/a.md?{"path":"/repo/docs/a.md","ref":""}',
				'git:/repo/docs/a.md?{"path":"/repo/docs/a.md","ref":"HEAD"}',
			],
			replies: [['bad', 'invalid fileAt request'], ['escape', 'invalid path'], ['head', 'bytes of /repo/docs/a.md'], ['index', 'bytes of /repo/docs/a.md'], ['new', true], ['outside', 'invalid path']],
			binary: ['PFB'],
		});
	});

	test('builds Word diff descriptors from the side names, and a side without the file is sideMissing', async () => {
		const sent: Uint8Array[] = [];
		const host = createHost(['HEAD:./a.docx'], sent, []);
		const context = {
			root: ROOT,
			resolvePath: (relative: string) => host.resolvePath('repo', relative),
			runGit: (args: readonly string[]) => host.runGit(ROOT, args),
		};
		const kinds = await Promise.all([
			paradisMobileWordDiffDescriptor(context, undefined, 'a.docx', 'head', 'original'),
			paradisMobileWordDiffDescriptor(context, undefined, 'a.docx', 'index', 'original'),
			paradisMobileWordDiffDescriptor(context, undefined, 'a.docx', 'worktree', 'modified'),
			paradisMobileWordDiffDescriptor(context, undefined, 'a.docx', 'missing', 'modified'),
			paradisMobileWordDiffDescriptor(context, undefined, '../a.docx', 'head', 'original'),
			// 作業ツリーで解決できない（外へ出るシンボリックリンクなど）のは「無い」ではなく誤り
			paradisMobileWordDiffDescriptor(context, undefined, 'gone.md', 'worktree', 'modified'),
		]);
		assert.deepStrictEqual(kinds.map(source => source === undefined ? undefined : [source.kind, source.side, source.uri]), [
			['gitCommit', 'original', 'git:/repo/a.docx?{"path":"/repo/a.docx","ref":"HEAD"}'],
			['sideMissing', 'original', undefined],
			['workingTree', 'modified', 'file:///repo/a.docx'],
			['sideMissing', 'modified', undefined],
			undefined,
			undefined,
		]);
	});

	test('answers a Word diff request that the next one from the same phone replaced with superseded', async () => {
		const sent: Uint8Array[] = [];
		const host = createHost(['HEAD:./a.docx'], sent, []);
		const negotiations: ((value: unknown) => void)[] = [];
		const sharedProcess = { getChannel: () => ({ call: () => new Promise(resolve => negotiations.push(resolve)) }) };
		const withShared: IParadisMobileRequestHost = {
			...host,
			invokeFunction: fn => host.invokeFunction(accessor => fn({ get: id => id === ISharedProcessService ? sharedProcess : accessor.get(id) } as ServicesAccessor)),
		};
		const dispatch = (id: string, path: string) => paradisDispatchMobileRequest('scm', { t: 'wordDiff', id, ws: 'repo', path, original: 'head', modified: 'worktree' }, 'phone', withShared);
		dispatch('first', 'a.docx');
		dispatch('second', 'a.docx');
		dispatch('escape', '../a.docx');
		await flush();
		// 話せない PC として答える（2 つ目だけが答えを受け取る。1 つ目は superseded を受け取り済み）
		negotiations.forEach(resolve => resolve(undefined));
		await flush();
		const replies = sent.map(payload => JSON.parse(new TextDecoder().decode(payload)) as { id: string; error?: string });
		assert.deepStrictEqual(replies.map(reply => [reply.id, reply.error === 'superseded' || reply.error === 'invalid path' ? reply.error : 'answered']), [
			['first', 'superseded'],
			['escape', 'invalid path'],
			['second', 'answered'],
		]);
	});
});
