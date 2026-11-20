/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_DOC_BACKGROUND_WATCH_EXCLUDES,
	PARADIS_DOC_BACKGROUND_WATCH_LINGER_MS,
	ParadisDocBackgroundWatchPlan,
	PARADIS_DOC_WATCH_BURST,
	PARADIS_DOC_WATCH_BURST_WINDOW_MS,
	ParadisDocWatchBurstGate,
	paradisIsWatchableDocPath,
	IParadisDocOwner,
	IParadisDocRecord,
	PARADIS_DOC_MAX_PREVIOUS_OWNERS,
	paradisDecideAdopt,
	paradisDocBelongsToFolder,
	paradisDocKey,
	paradisDocKind,
	paradisDocOwnerRelation,
	paradisIsInsideFolder,
	paradisIsVcsInternalPath,
	paradisNormalizeDocPath,
	paradisParseDocLedger,
	paradisParseDocsToolCall,
	paradisSerializeDocLedger,
	paradisWithDocOwner,
} from '../../common/paradisAgentDocs.js';

function owner(session: string, extra: Partial<IParadisDocOwner> = {}): IParadisDocOwner {
	return { agent: 'claude', session, via: 'write', since: 1, ...extra };
}

function record(path: string, extra: Partial<IParadisDocRecord> = {}): IParadisDocRecord {
	return { hostId: '', path, kind: 'html', previousOwners: [], writes: [], registeredBy: 'write', firstSeen: 1, ...extra };
}

suite('paradisAgentDocs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('normalizes absolute paths and rejects the rest', () => {
		assert.deepStrictEqual([
			paradisNormalizeDocPath('/work/./a/../report.html'),
			paradisNormalizeDocPath('/work/docs/'),
			paradisNormalizeDocPath('C:\\work\\.\\a.md'),
			// ドライブ文字の大小（URI.fsPath は小文字、hook は大文字）で台帳とサイドカーのキーが分かれない
			paradisDocKey('', paradisNormalizeDocPath('c:\\work\\a.md')!) === paradisDocKey('', paradisNormalizeDocPath('C:\\work\\a.md')!),
			paradisNormalizeDocPath('report.html'),
			paradisNormalizeDocPath('./report.html'),
			paradisNormalizeDocPath('/work/a\nb.html'),
			paradisNormalizeDocPath(42),
		], ['/work/report.html', '/work/docs', 'C:\\work\\a.md', true, undefined, undefined, undefined, undefined]);
	});

	test('decides the kind, the key and the version control folders', () => {
		assert.deepStrictEqual({
			kinds: ['/a.html', '/a.HTM', '/a.md', '/a.markdown', '/a.txt', '/html'].map(paradisDocKind),
			keys: [paradisDocKey('', '/a.md'), paradisDocKey('ssh-remote-box', '/a.md')],
			vcs: ['/repo/.git/x.md', '/repo/docs/x.md', 'C:\\repo\\.svn\\a.html'].map(paradisIsVcsInternalPath),
		}, {
			kinds: ['html', 'html', 'md', undefined, undefined, undefined],
			keys: ['local:/a.md', 'ssh:ssh-remote-box:/a.md'],
			vcs: [true, false, true],
		});
	});

	test('tells whether a path is inside a folder', () => {
		assert.deepStrictEqual([
			paradisIsInsideFolder('/work/a.md', '/work'),
			paradisIsInsideFolder('/work', '/work'),
			paradisIsInsideFolder('/workshop/a.md', '/work'),
			paradisIsInsideFolder('/a.md', '/'),
			paradisIsInsideFolder('C:\\Work\\a.md', 'c:\\work'),
			paradisIsInsideFolder('/work/a.md', 'C:\\work'),
		], [true, true, false, true, true, false]);
	});

	test('a document belongs to a space by its folder or by the folder its session started in', () => {
		const folder = { hostId: '', path: '/repo' };
		assert.deepStrictEqual([
			paradisDocBelongsToFolder(record('/repo/docs/a.html'), folder),
			paradisDocBelongsToFolder(record('/tmp/a.html', { owner: owner('s1', { cwd: '/repo' }) }), folder),
			paradisDocBelongsToFolder(record('/tmp/a.html', { owner: owner('s1', { cwd: '/other' }) }), folder),
			paradisDocBelongsToFolder(record('/repo/a.html', { hostId: 'box' }), folder),
			paradisDocBelongsToFolder(record('/repo/a.html', { hostId: 'box' }), { hostId: 'box', path: '/repo' }),
		], [true, true, false, false, true]);
	});

	test('names the owner relative to the caller without other session ids', () => {
		assert.deepStrictEqual([
			paradisDocOwnerRelation(undefined, 's1'),
			paradisDocOwnerRelation(owner('s1'), 's1'),
			paradisDocOwnerRelation(owner('s2'), 's1'),
			paradisDocOwnerRelation(owner('s2', { ended: 5 }), 's1'),
			paradisDocOwnerRelation(owner('s2'), undefined),
		], ['none', 'this_session', 'other_session', 'ended_session', 'other_session']);
	});

	test('asks the user only when the owner may still be running', () => {
		assert.deepStrictEqual([
			paradisDecideAdopt(undefined, 's1', 'unknown'),
			paradisDecideAdopt(owner('s1'), 's1', 'live'),
			paradisDecideAdopt(owner('s2', { ended: 5 }), 's1', 'ended'),
			paradisDecideAdopt(owner('s2'), 's1', 'ended'),
			paradisDecideAdopt(owner('s2'), 's1', 'live'),
			paradisDecideAdopt(owner('s2'), 's1', 'unknown'),
			// 終了の印があっても、どこかのペインで動いているなら確かめる
			paradisDecideAdopt(owner('s2', { ended: 5 }), 's1', 'live'),
		], ['register', 'already_yours', 'take_over', 'take_over', 'confirm', 'confirm', 'confirm']);
	});

	test('keeps the previous owners when the owner changes and clears the end mark when the same session comes back', () => {
		let doc = record('/a.html', { owner: owner('s1') });
		for (let index = 2; index <= PARADIS_DOC_MAX_PREVIOUS_OWNERS + 3; index++) {
			doc = paradisWithDocOwner(doc, owner(`s${index}`));
		}
		const ended = { ...doc, owner: { ...doc.owner!, ended: 9 } };
		assert.deepStrictEqual({
			owner: doc.owner?.session,
			previous: doc.previousOwners.map(entry => entry.session),
			resumed: paradisWithDocOwner(ended, owner(doc.owner!.session)).owner,
		}, {
			owner: 's8',
			previous: ['s7', 's6', 's5', 's4', 's3'],
			resumed: owner('s8'),
		});
	});

	test('reads back what it wrote and drops broken entries', () => {
		const good = record('/work/a.md', { kind: 'md', owner: owner('s1', { cwd: '/work' }), writes: [{ at: 3, tool: 'Edit', session: 's1', toolUseId: 't1' }] });
		const text = JSON.stringify({ version: 1, docs: [good, { path: 'relative.md' }, { ...good, path: '/work/a.txt' }, good, { ...good, owner: { agent: 'robot', session: 's', via: 'write', since: 1 } }] });
		assert.deepStrictEqual({
			roundTrip: paradisParseDocLedger(paradisSerializeDocLedger([good])),
			mixed: paradisParseDocLedger(text).map(entry => [entry.path, entry.owner?.session]),
			broken: [paradisParseDocLedger(undefined), paradisParseDocLedger('{'), paradisParseDocLedger('[]')],
		}, {
			roundTrip: [good],
			mixed: [['/work/a.md', 's1']],
			broken: [[], [], []],
		});
	});

	test('the file watch takes html and md outside dependency and version control folders, and stops while many files change at once', () => {
		assert.deepStrictEqual([
			'/repo/report.html', '/repo/docs/guide.md', 'C:\\repo\\notes.MD',
			'/repo/main.ts', '/repo/node_modules/pkg/README.md', '/repo/.git/COMMIT_EDITMSG.md', '/repo/.venv/lib/site-packages/x/index.html', 'C:\\repo\\node_modules\\pkg\\readme.md',
		].map(paradisIsWatchableDocPath), [true, true, true, false, false, false, false, false]);
		const gate = new ParadisDocWatchBurstGate();
		assert.deepStrictEqual([
			gate.admit(1, 0), gate.admit(PARADIS_DOC_WATCH_BURST - 1, 1000),
			// 短い間の合計が上限を超えた（ブランチの切り替えが小分けに届く）。収まるまで通さない
			gate.admit(1, 2000), gate.admit(1, 5000), gate.admit(1, 14_000),
			gate.admit(1, 14_000 + PARADIS_DOC_WATCH_BURST_WINDOW_MS),
			// 1 回の知らせが上限を超えた
			gate.admit(PARADIS_DOC_WATCH_BURST + 1, 100_000), gate.admit(1, 100_001), gate.admit(1, 100_001 + PARADIS_DOC_WATCH_BURST_WINDOW_MS),
		], [true, true, false, false, false, true, false, false, true]);
	});

	test('the watch of spaces that are not displayed follows the working agents, lingers after they stop, and skips dependency folders', () => {
		const plan = new ParadisDocBackgroundWatchPlan();
		assert.deepStrictEqual([
			plan.update(['/a', '/b'], 1_000),
			plan.update(['/b'], 2_000),
			plan.update([], 1_000 + PARADIS_DOC_BACKGROUND_WATCH_LINGER_MS + 1),
			plan.update(['/c'], 3_000 + PARADIS_DOC_BACKGROUND_WATCH_LINGER_MS, folder => folder === '/b'),
			plan.update([], 4_000 + 2 * PARADIS_DOC_BACKGROUND_WATCH_LINGER_MS),
		], [['/a', '/b'], ['/b', '/a'], ['/b'], ['/c'], []]);
		assert.deepStrictEqual(PARADIS_DOC_BACKGROUND_WATCH_EXCLUDES.filter(glob => glob === '**/node_modules/**' || glob === '**/.git/**'), ['**/.git/**', '**/node_modules/**']);
	});

	test('checks the tool arguments strictly', () => {
		assert.deepStrictEqual([
			paradisParseDocsToolCall('list_tabs', {}),
			paradisParseDocsToolCall('list_docs', undefined),
			paradisParseDocsToolCall('list_docs', { scope: 'space', only_open_comments: true }),
			paradisParseDocsToolCall('list_docs', { scope: 'all' })?.ok,
			paradisParseDocsToolCall('list_docs', { limit: 3 })?.ok,
			paradisParseDocsToolCall('adopt_doc', { paths: ['/a.md', '/a.md'], reason: ' 引き継ぎ\n' }),
			paradisParseDocsToolCall('adopt_doc', { paths: [] })?.ok,
			paradisParseDocsToolCall('adopt_doc', { paths: ['a.md'] })?.ok,
			paradisParseDocsToolCall('adopt_doc', { paths: ['/a.md'], reason: 'x'.repeat(201) })?.ok,
			paradisParseDocsToolCall('adopt_doc', { path: '/a.md' })?.ok,
			paradisParseDocsToolCall('adopt_doc', [])?.ok,
		], [
			undefined,
			{ ok: true, tool: 'list_docs', args: { scope: 'session', onlyOpenComments: false } },
			{ ok: true, tool: 'list_docs', args: { scope: 'space', onlyOpenComments: true } },
			false,
			false,
			{ ok: true, tool: 'adopt_doc', args: { paths: ['/a.md'], reason: '引き継ぎ' } },
			false,
			false,
			false,
			false,
			false,
		]);
	});
});
