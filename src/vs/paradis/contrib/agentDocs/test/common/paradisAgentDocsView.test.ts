/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IParadisDocRecord, paradisParseDocLedger, paradisSerializeDocLedger } from '../../common/paradisAgentDocs.js';
import {
	IParadisDocsFilter,
	IParadisDocViewRecord,
	paradisDocDateBucket,
	paradisDocOwnerStatus,
	paradisDocViewRecord,
	paradisFilterDocs,
	paradisGroupDocs,
} from '../../common/paradisAgentDocsView.js';

function doc(path: string, lastActivity: number, extra: Partial<IParadisDocViewRecord> = {}): IParadisDocViewRecord {
	return { hostId: '', path, kind: path.endsWith('.md') ? 'md' : 'html', registeredBy: 'write', lastActivity, ...extra };
}

function owned(session: string, cwd = '/repo', liveness: IParadisDocViewRecord['liveness'] = 'live'): Partial<IParadisDocViewRecord> {
	return { owner: { agent: 'claude', session, cwd, via: 'write' }, liveness };
}

const FILTER: IParadisDocsFilter = { scope: 'all', hostId: '', html: true, md: true, query: '' };

const paths = (records: readonly IParadisDocViewRecord[]) => records.map(record => record.path);

suite('ParadisAgentDocsView', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the ledger keeps documents the user opened and the missing mark across a reload', () => {
		const records: IParadisDocRecord[] = [
			{ hostId: '', path: '/repo/old.md', kind: 'md', previousOwners: [], writes: [], registeredBy: 'user_opened', firstSeen: 5, missingSince: 9 },
			{ hostId: '', path: '/repo/given.html', kind: 'html', owner: { agent: 'claude', session: 's1', via: 'user', since: 7 }, previousOwners: [], writes: [], registeredBy: 'user_opened', firstSeen: 6 },
		];
		assert.deepStrictEqual(paradisParseDocLedger(paradisSerializeDocLedger(records)), records);
	});

	test('the view record carries the owner, liveness and last activity, not the write log', () => {
		const record: IParadisDocRecord = {
			hostId: 'h', path: '/w/a.html', kind: 'html', owner: { agent: 'codex', session: 's', cwd: '/w', via: 'adopt', since: 20, ended: 30 },
			previousOwners: [{ agent: 'claude', session: 'old', via: 'write', since: 1 }], writes: [{ at: 25, tool: 'Write', session: 's' }], registeredBy: 'write', firstSeen: 1,
		};
		assert.deepStrictEqual([paradisDocViewRecord(record, 'ended'), paradisDocViewRecord({ ...record, owner: undefined }, undefined)], [
			{ hostId: 'h', path: '/w/a.html', kind: 'html', owner: { agent: 'codex', session: 's', cwd: '/w', via: 'adopt' }, liveness: 'ended', registeredBy: 'write', lastActivity: 25 },
			{ hostId: 'h', path: '/w/a.html', kind: 'html', registeredBy: 'write', lastActivity: 25 },
		]);
	});

	test('filters by scope, host, kind and search words, newest first', () => {
		const records = [
			doc('/repo/docs/plan.md', 10, owned('s1')),
			doc('/repo/mock/screen.html', 30, owned('s2')),
			doc('/tmp/scratch/notes.md', 20, owned('s1', '/repo/sub')),
			doc('/other/report.html', 40, owned('s3', '/other')),
			doc('/repo/remote.html', 50, { hostId: 'ssh-host', ...owned('s4') }),
			doc('/repo/old.md', 5),
		];
		const folder = { hostId: '', path: '/repo' };
		assert.deepStrictEqual({
			all: paths(paradisFilterDocs(records, FILTER)),
			space: paths(paradisFilterDocs(records, { ...FILTER, scope: 'space', folder })),
			spaceUnknown: paths(paradisFilterDocs(records, { ...FILTER, scope: 'space' })),
			session: paths(paradisFilterDocs(records, { ...FILTER, scope: 'session', session: 's1' })),
			sessionUnknown: paths(paradisFilterDocs(records, { ...FILTER, scope: 'session' })),
			htmlOnly: paths(paradisFilterDocs(records, { ...FILTER, md: false })),
			search: paths(paradisFilterDocs(records, { ...FILTER, query: '  REPO  md ' })),
			remoteWindow: paths(paradisFilterDocs(records, { ...FILTER, hostId: 'ssh-host' })),
		}, {
			all: ['/other/report.html', '/repo/mock/screen.html', '/tmp/scratch/notes.md', '/repo/docs/plan.md', '/repo/old.md'],
			space: ['/repo/mock/screen.html', '/tmp/scratch/notes.md', '/repo/docs/plan.md', '/repo/old.md'],
			spaceUnknown: [],
			session: ['/tmp/scratch/notes.md', '/repo/docs/plan.md'],
			sessionUnknown: [],
			htmlOnly: ['/other/report.html', '/repo/mock/screen.html'],
			search: ['/repo/docs/plan.md', '/repo/old.md'],
			remoteWindow: ['/repo/remote.html'],
		});
	});

	test('the status of the owner', () => {
		assert.deepStrictEqual([
			paradisDocOwnerStatus(doc('/a.html', 1, owned('s', '/', 'live'))),
			paradisDocOwnerStatus(doc('/a.html', 1, owned('s', '/', 'ended'))),
			paradisDocOwnerStatus(doc('/a.html', 1, owned('s', '/', 'unknown'))),
			paradisDocOwnerStatus(doc('/a.html', 1, { owner: { agent: 'claude', session: 's', via: 'write' } })),
			paradisDocOwnerStatus(doc('/a.html', 1)),
		], ['live', 'ended', 'unknown', 'unknown', 'none']);
	});

	test('date buckets count from midnight of the local day', () => {
		const now = new Date(2026, 10, 18, 9, 0).getTime();
		const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).getTime();
		assert.deepStrictEqual(
			[at(18, 0), at(17, 23), at(17, 0), at(16, 12), at(12, 0), at(11, 23)].map(time => paradisDocDateBucket(time, now)),
			['today', 'yesterday', 'yesterday', 'week', 'week', 'older'],
		);
	});

	test('groups by session (newest session first, documents without an owner last), by date and by folder', () => {
		const now = new Date(2026, 10, 18, 12, 0).getTime();
		const records = paradisFilterDocs([
			doc('/repo/docs/a.md', now - 1000, owned('s1')),
			doc('/repo/mock/b.html', now - 2000, owned('s2', '/repo', 'ended')),
			doc('/repo/docs/c.html', now - 3 * 24 * 3600 * 1000, owned('s1')),
			doc('/repo/old.md', now - 30 * 24 * 3600 * 1000),
		], FILTER);
		const summary = (grouping: 'session' | 'date' | 'folder') => paradisGroupDocs(records, grouping, now).map(group => ({ key: group.key, ...(group.kind === 'session' ? { status: group.status } : {}), paths: paths(group.records) }));
		assert.deepStrictEqual({ session: summary('session'), date: summary('date'), folder: summary('folder') }, {
			session: [
				{ key: 'session:s1', status: 'live', paths: ['/repo/docs/a.md', '/repo/docs/c.html'] },
				{ key: 'session:s2', status: 'ended', paths: ['/repo/mock/b.html'] },
				{ key: 'unowned', paths: ['/repo/old.md'] },
			],
			date: [
				{ key: 'date:today', paths: ['/repo/docs/a.md', '/repo/mock/b.html'] },
				{ key: 'date:week', paths: ['/repo/docs/c.html'] },
				{ key: 'date:older', paths: ['/repo/old.md'] },
			],
			folder: [
				{ key: 'folder:/repo', paths: ['/repo/old.md'] },
				{ key: 'folder:/repo/docs', paths: ['/repo/docs/a.md', '/repo/docs/c.html'] },
				{ key: 'folder:/repo/mock', paths: ['/repo/mock/b.html'] },
			],
		});
	});
});
