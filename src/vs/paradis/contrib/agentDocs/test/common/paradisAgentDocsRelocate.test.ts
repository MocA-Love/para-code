/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { paradisDocKind } from '../../common/paradisAgentDocs.js';
import { IParadisDocFileStat, IParadisDocFingerprintUpdate, IParadisDocRelocatorHost, PARADIS_DOC_FINGERPRINT_MAX_BYTES, PARADIS_DOC_MISSING_RETENTION_MS, PARADIS_DOC_RELOCATE_RETRY_MS, ParadisDocRelocator, paradisDocMountPoint, paradisDocRootOf } from '../../common/paradisAgentDocsRelocate.js';
import { IParadisDocViewRecord } from '../../common/paradisAgentDocsView.js';

interface IFakeFile {
	readonly content: string;
	readonly mtime: number;
	/** 中身の長さと違う大きさを名乗らせる（大きすぎるファイル）。 */
	readonly size?: number;
}

/** ファイルと台帳を持つ、追従のテスト用の相手。 */
class FakeHost implements IParadisDocRelocatorHost {

	readonly hostId = '';
	time = 1_000;
	rootList = ['/repo'];
	complete = true;
	readonly files = new Map<string, IFakeFile>();
	records: IParadisDocViewRecord[] = [];
	/** 台帳が断る移動先。 */
	readonly refused = new Set<string>();
	readonly searches: string[] = [];
	readonly hashed: string[] = [];
	readonly log: string[] = [];

	doc(path: string, content: string | undefined, extra: Partial<IParadisDocViewRecord> = {}): void {
		if (content !== undefined) {
			this.files.set(path, { content, mtime: 10 });
		}
		this.records.push({ hostId: '', path, kind: paradisDocKind(path)!, registeredBy: 'write', owner: { agent: 'claude', session: 's1', via: 'write' }, lastActivity: 500, ...extra });
	}

	move(from: string, to: string): void {
		this.files.set(to, this.files.get(from)!);
		this.files.delete(from);
	}

	now(): number {
		return this.time;
	}

	async list(): Promise<readonly IParadisDocViewRecord[]> {
		return this.records;
	}

	roots(): readonly string[] {
		return this.rootList;
	}

	/** 在るフォルダ（ファイルではないので、stat は「確かめられない」を返す）。 */
	readonly folders = new Set<string>();

	async stat(path: string): Promise<IParadisDocFileStat | 'missing' | undefined> {
		if (this.folders.has(path)) {
			return undefined;
		}
		const file = this.files.get(path);
		return file !== undefined ? { size: file.size ?? file.content.length, mtime: file.mtime } : 'missing';
	}

	async hash(path: string): Promise<{ hash: string; size: number } | undefined> {
		const file = this.files.get(path);
		this.hashed.push(path);
		return file !== undefined ? { hash: `hash of ${file.content}`, size: file.content.length } : undefined;
	}

	/** 探索を失敗させる。 */
	searchFails = false;

	async findDocs(root: string): Promise<{ paths: readonly string[]; complete: boolean } | undefined> {
		this.searches.push(root);
		if (this.searchFails) {
			return undefined;
		}
		return { paths: [...this.files.keys()].filter(path => path.startsWith(`${root}/`)), complete: this.complete };
	}

	async setFingerprints(updates: readonly IParadisDocFingerprintUpdate[]): Promise<void> {
		this.records = this.records.map(record => {
			const update = updates.find(candidate => candidate.path === record.path);
			return update !== undefined ? { ...record, fingerprint: update.fingerprint } : record;
		});
	}

	async setMissing(path: string, missing: boolean): Promise<void> {
		this.log.push(`${missing ? 'missing' : 'found'} ${path}`);
		this.records = this.records.map(record => {
			if (record.path !== path) {
				return record;
			}
			// 台帳（ParadisDocLedger.setMissing）と同じ: 既に見つからない記録で数え始めが無ければ、数え始めだけを入れる
			if (missing && record.missingSince !== undefined) {
				return record.missingCountedFrom === undefined ? { ...record, missingCountedFrom: this.time } : record;
			}
			const { missingSince: _missingSince, missingCountedFrom: _missingCountedFrom, ...present } = record;
			return missing ? { ...present, missingSince: this.time, missingCountedFrom: this.time } : present;
		});
	}

	async relocate(from: string, to: string, hash: string): Promise<boolean> {
		if (this.refused.has(to) || this.records.find(record => record.path === from)?.fingerprint?.hash !== hash) {
			this.log.push(`refused ${from} -> ${to}`);
			return false;
		}
		this.log.push(`relocate ${from} -> ${to}`);
		this.records = this.records.filter(record => record.path !== to).map(record => {
			if (record.path !== from) {
				return record;
			}
			const { missingSince: _missingSince, ...present } = record;
			return { ...present, path: to };
		});
		return true;
	}

	async remove(paths: readonly string[]): Promise<void> {
		this.log.push(`remove ${paths.join(' ')}`);
		this.records = this.records.filter(record => !paths.includes(record.path));
	}

	state(): string[] {
		return this.records.map(record => `${record.path}${record.missingSince !== undefined ? ' (missing)' : ''}`);
	}
}

suite('ParadisAgentDocsRelocate', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('the root of a document is the deepest space that holds it', () => {
		const roots = ['/repo', '/repo/worktrees/a', '/other'];
		assert.deepStrictEqual(['/repo/x.md', '/repo/worktrees/a/x.md', '/repository/x.md', '/tmp/x.md'].map(path => paradisDocRootOf(path, roots)), ['/repo', '/repo/worktrees/a', undefined, undefined]);
	});

	test('fingerprints are taken inside a space only, and again only when the document was written or changed', async () => {
		const host = new FakeHost();
		host.doc('/repo/a.md', 'alpha');
		host.doc('/tmp/out.html', 'outside');
		host.doc('/repo/empty.md', '');
		host.doc('/repo/big.html', 'big');
		host.files.set('/repo/big.html', { content: 'big', mtime: 10, size: PARADIS_DOC_FINGERPRINT_MAX_BYTES + 1 });
		const relocator = new ParadisDocRelocator(host);
		await relocator.sync();
		const first = host.records.map(record => record.fingerprint);
		await relocator.sync();
		const afterIdle = [...host.hashed];
		// 書かれた（最後の動きが指紋より新しい）が、大きさと更新時刻は同じ: 読み直さず、取った時刻だけ進める
		host.time = 2_000;
		host.records = host.records.map(record => record.path === '/repo/a.md' ? { ...record, lastActivity: 1_500 } : record);
		await relocator.sync();
		const afterTouch = { hashed: [...host.hashed], fingerprint: host.records[0].fingerprint };
		// 中身が変わったと知らされた: 読み直す
		host.files.set('/repo/a.md', { content: 'alpha 2', mtime: 20 });
		await relocator.filesChanged({ added: [], updated: ['/repo/a.md', '/repo/unknown.md'], deleted: [] });
		assert.deepStrictEqual({ first, afterIdle, afterTouch, afterChange: { hashed: host.hashed, fingerprint: host.records[0].fingerprint }, log: host.log }, {
			first: [{ size: 5, mtime: 10, hash: 'hash of alpha', at: 1_000 }, undefined, undefined, undefined],
			afterIdle: ['/repo/a.md'],
			afterTouch: { hashed: ['/repo/a.md'], fingerprint: { size: 5, mtime: 10, hash: 'hash of alpha', at: 2_000 } },
			afterChange: { hashed: ['/repo/a.md', '/repo/a.md'], fingerprint: { size: 7, mtime: 20, hash: 'hash of alpha 2', at: 2_000 } },
			log: [],
		});
	});

	test('a moved document is followed by its content, before it is ever marked missing', async () => {
		const host = new FakeHost();
		host.doc('/repo/plan.md', 'the plan');
		host.doc('/repo/docs/guide.html', 'the guide');
		host.doc('/repo/keep.md', 'kept');
		const relocator = new ParadisDocRelocator(host);
		await relocator.sync();
		// 同じ名前のまま別のフォルダへ。別のフォルダへ、名前も変えて。フォルダごと消えた知らせ
		host.move('/repo/plan.md', '/repo/mock/notes/plan.md');
		host.move('/repo/docs/guide.html', '/repo/mock/guide-v2.html');
		await relocator.filesChanged({ added: ['/repo/mock/notes/plan.md'], updated: [], deleted: ['/repo/plan.md', '/repo/docs', '/repo/other.txt'] });
		assert.deepStrictEqual({ state: host.state(), log: host.log, searches: host.searches }, {
			state: ['/repo/mock/notes/plan.md', '/repo/mock/guide-v2.html', '/repo/keep.md'],
			log: ['relocate /repo/plan.md -> /repo/mock/notes/plan.md', 'relocate /repo/docs/guide.html -> /repo/mock/guide-v2.html'],
			searches: ['/repo'],
		});
	});

	test('a file with the same name but another content, two copies, or a place the ledger refuses is never taken', async () => {
		const host = new FakeHost();
		host.doc('/repo/report.html', 'report of session 1');
		host.doc('/repo/twin.md', 'twin');
		host.doc('/repo/taken.md', 'same words');
		host.doc('/repo/other/owned.md', 'same words');
		host.doc('/repo/refused.md', 'refused');
		host.doc('/repo/named.md', 'named');
		const relocator = new ParadisDocRelocator(host);
		await relocator.sync();
		// 同じ名前の別物（大きさは同じ）
		host.files.delete('/repo/report.html');
		host.files.set('/repo/archive/report.html', { content: 'report of session 2', mtime: 30 });
		// 同じ中身が 2 か所
		host.move('/repo/twin.md', '/repo/a/twin.md');
		host.files.set('/repo/b/twin.md', { content: 'twin', mtime: 30 });
		// 同じ中身のファイルは、別の資料として載っている
		host.files.delete('/repo/taken.md');
		// 同じ名前で移した先のほかに、別の名前の写しがある
		host.move('/repo/named.md', '/repo/a/named.md');
		host.files.set('/repo/b/copy-of-named.md', { content: 'named', mtime: 30 });
		// 台帳が断る
		host.move('/repo/refused.md', '/repo/z/refused.md');
		host.refused.add('/repo/z/refused.md');
		await relocator.filesChanged({ added: [], updated: [], deleted: ['/repo/report.html', '/repo/twin.md', '/repo/taken.md', '/repo/refused.md', '/repo/named.md'] });
		await relocator.sync();
		assert.deepStrictEqual({ state: host.state(), log: host.log, searches: host.searches }, {
			state: ['/repo/report.html (missing)', '/repo/twin.md (missing)', '/repo/taken.md (missing)', '/repo/other/owned.md', '/repo/refused.md (missing)', '/repo/named.md (missing)'],
			log: ['refused /repo/refused.md -> /repo/z/refused.md', 'missing /repo/report.html', 'missing /repo/twin.md', 'missing /repo/taken.md', 'missing /repo/refused.md', 'missing /repo/named.md'],
			searches: ['/repo'],
		});
	});

	test('a document already missing is searched once; without a fingerprint or a full search nothing is decided; a file that shows up later is checked by itself', async () => {
		const host = new FakeHost();
		const fingerprint = (content: string) => ({ size: content.length, mtime: 10, hash: `hash of ${content}`, at: 900 });
		host.doc('/repo/old.md', undefined, { missingSince: 800, missingCountedFrom: 800 });
		host.doc('/repo/moved.md', undefined, { missingSince: 800, missingCountedFrom: 800, fingerprint: fingerprint('moved') });
		host.doc('/repo/later.html', undefined, { missingSince: 800, missingCountedFrom: 800, fingerprint: fingerprint('later') });
		host.doc('/repo/back.md', undefined, { missingSince: 800, missingCountedFrom: 800, fingerprint: fingerprint('back') });
		host.doc('/elsewhere/gone.md', undefined, { missingSince: 800, missingCountedFrom: 800, fingerprint: fingerprint('moved') });
		host.files.set('/repo/sub/moved.md', { content: 'moved', mtime: 10 });
		// 見張りが先に載せた、持ち主の無い記録は移動先にできる
		host.doc('/repo/sub/moved.md', undefined, { registeredBy: 'watch', owner: undefined });
		const relocator = new ParadisDocRelocator(host);
		host.complete = false;
		await relocator.sync();
		const incomplete = host.state();
		// 探しきれなかった資料も、この起動の間は探し直さない
		host.complete = true;
		await relocator.sync();
		const searchesAfterTwo = [...host.searches];
		const fresh = new ParadisDocRelocator(host);
		await fresh.sync();
		await fresh.sync();
		const afterSearch = host.state();
		host.files.set('/repo/new/renamed.html', { content: 'later', mtime: 40 });
		host.files.set('/repo/back.md', { content: 'back', mtime: 40 });
		await fresh.filesChanged({ added: ['/repo/new/renamed.html', '/repo/back.md', '/repo/node_modules/x/renamed.html'], updated: [], deleted: [] });
		assert.deepStrictEqual({ incomplete, searchesAfterTwo, afterSearch, state: host.state(), log: host.log, searches: host.searches }, {
			incomplete: ['/repo/old.md (missing)', '/repo/moved.md (missing)', '/repo/later.html (missing)', '/repo/back.md (missing)', '/elsewhere/gone.md (missing)', '/repo/sub/moved.md'],
			searchesAfterTwo: ['/repo'],
			afterSearch: ['/repo/old.md (missing)', '/repo/sub/moved.md', '/repo/later.html (missing)', '/repo/back.md (missing)', '/elsewhere/gone.md (missing)'],
			state: ['/repo/old.md (missing)', '/repo/sub/moved.md', '/repo/new/renamed.html', '/repo/back.md', '/elsewhere/gone.md (missing)'],
			log: ['relocate /repo/moved.md -> /repo/sub/moved.md', 'found /repo/back.md', 'relocate /repo/later.html -> /repo/new/renamed.html'],
			searches: ['/repo', '/repo'],
		});
	});

	test('a document missing for seven days is removed after one more look; one that is back is kept', async () => {
		const host = new FakeHost();
		host.time = PARADIS_DOC_MISSING_RETENTION_MS + 10_000;
		host.doc('/repo/long-gone.md', undefined, { missingSince: 5_000, missingCountedFrom: 5_000 });
		host.doc('/tmp/outside-gone.html', undefined, { missingSince: 10_000, missingCountedFrom: 10_000 });
		host.doc('/repo/recent.md', undefined, { missingSince: 10_001, missingCountedFrom: 10_001 });
		// 見つからなくなったのは古いが、数え始めは新しい（前の版の間に見つからなくなった資料）
		host.doc('/repo/counted-late.md', undefined, { missingSince: 5_000, missingCountedFrom: 10_001 });
		host.doc('/repo/back.md', 'back again', { missingSince: 5_000, missingCountedFrom: 5_000 });
		const relocator = new ParadisDocRelocator(host);
		await relocator.sync();
		assert.deepStrictEqual({ state: host.state(), log: host.log }, {
			state: ['/repo/recent.md (missing)', '/repo/counted-late.md (missing)', '/repo/back.md'],
			log: ['found /repo/back.md', 'remove /repo/long-gone.md /tmp/outside-gone.html'],
		});
	});

	test('a document that went missing before the count was recorded is counted from the first look, kept across restarts, and removed seven days after that', async () => {
		const host = new FakeHost();
		// 前の版の間に、7 日より前から見つからない資料（数え始めの記録が無い）
		host.time = 3 * PARADIS_DOC_MISSING_RETENTION_MS;
		host.doc('/repo/old-record.md', undefined, { missingSince: 5_000 });
		// 閉じている間に置き直されていた資料は、数え始めを入れずに印を外す
		host.doc('/repo/old-record-back.md', 'back again', { missingSince: 5_000 });
		await new ParadisDocRelocator(host).sync();
		const first = { state: host.state(), countedFrom: host.records[0].missingCountedFrom, since: host.records[0].missingSince };
		// 開き直しても（追従を作り直しても）、数え始めは台帳に残っていて進まない
		host.time += PARADIS_DOC_MISSING_RETENTION_MS - 1;
		await new ParadisDocRelocator(host).sync();
		const beforeDue = { state: host.state(), countedFrom: host.records[0]?.missingCountedFrom };
		host.time += 1;
		await new ParadisDocRelocator(host).sync();
		assert.deepStrictEqual({ first, beforeDue, state: host.state(), log: host.log }, {
			first: { state: ['/repo/old-record.md (missing)', '/repo/old-record-back.md'], countedFrom: 3 * PARADIS_DOC_MISSING_RETENTION_MS, since: 5_000 },
			beforeDue: { state: ['/repo/old-record.md (missing)', '/repo/old-record-back.md'], countedFrom: 3 * PARADIS_DOC_MISSING_RETENTION_MS },
			state: ['/repo/old-record-back.md'],
			log: ['missing /repo/old-record.md', 'found /repo/old-record-back.md', 'remove /repo/old-record.md'],
		});
	});

	test('a failed search is tried again after a while, and a copy in a nested space is not a place to move to', async () => {
		const host = new FakeHost();
		host.rootList = ['/repo', '/repo/worktrees/a'];
		const fingerprint = { size: 5, mtime: 10, hash: 'hash of moved', at: 900 };
		host.doc('/repo/moved.md', undefined, { missingSince: 800, missingCountedFrom: 800, fingerprint });
		host.doc('/repo/tracked.md', undefined, { missingSince: 800, missingCountedFrom: 800, fingerprint: { ...fingerprint, hash: 'hash of track' } });
		host.files.set('/repo/sub/moved.md', { content: 'moved', mtime: 10 });
		// 入れ子のワークツリーにある、同じ中身の別のファイル
		host.files.set('/repo/worktrees/a/tracked.md', { content: 'track', mtime: 10 });
		const relocator = new ParadisDocRelocator(host);
		host.searchFails = true;
		await relocator.sync();
		await relocator.sync();
		const failed = { state: host.state(), searches: [...host.searches], needsRetry: relocator.needsRetry };
		host.searchFails = false;
		host.time += PARADIS_DOC_RELOCATE_RETRY_MS;
		await relocator.sync();
		await relocator.filesChanged({ added: ['/repo/worktrees/a/tracked.md'], updated: [], deleted: [] });
		assert.deepStrictEqual({ failed, state: host.state(), searches: host.searches, needsRetry: relocator.needsRetry, log: host.log }, {
			failed: { state: ['/repo/moved.md (missing)', '/repo/tracked.md (missing)'], searches: ['/repo'], needsRetry: true },
			state: ['/repo/sub/moved.md', '/repo/tracked.md (missing)'],
			searches: ['/repo', '/repo'],
			needsRetry: false,
			log: ['relocate /repo/moved.md -> /repo/sub/moved.md'],
		});
	});

	test('a document on a removable volume that is not mounted is not removed', async () => {
		const host = new FakeHost();
		host.time = PARADIS_DOC_MISSING_RETENTION_MS + 10_000;
		host.doc('/Volumes/SSD/work/a.md', undefined, { missingSince: 5_000, missingCountedFrom: 5_000 });
		host.doc('/Volumes/Mounted/work/b.md', undefined, { missingSince: 5_000, missingCountedFrom: 5_000 });
		host.folders.add('/Volumes/Mounted');
		await new ParadisDocRelocator(host).sync();
		assert.deepStrictEqual({
			state: host.state(),
			mounts: ['/Volumes/SSD/a.md', '/mnt/disk/x/a.md', '/media/user/usb/a.md', '/run/media/user/usb/a.md', '/home/user/a.md', '/Volumes/a.md'].map(paradisDocMountPoint),
		}, {
			state: ['/Volumes/SSD/work/a.md (missing)'],
			mounts: ['/Volumes/SSD', '/mnt/disk', '/media/user/usb', '/run/media/user/usb', undefined, undefined],
		});
	});
});
