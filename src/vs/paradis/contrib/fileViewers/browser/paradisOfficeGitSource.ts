/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import type { IOfficeSourceProvider, ParadisOfficeProviderSnapshot } from '../common/paradisOfficeSourceBroker.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeOutcome, type ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';

export type ParadisOfficeGitComparisonKind = 'headToIndex' | 'indexToWorking';
export type ParadisOfficeGitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ParadisOfficeGitChange {
	readonly status: ParadisOfficeGitChangeStatus;
	readonly path: string;
	readonly originalPath?: string;
}

/** Metadata exposed by the existing Git repository/status provider. */
export interface ParadisOfficeGitRepositorySnapshot {
	readonly repositoryRoot: URI;
	readonly headCommit: string;
	readonly indexChecksum: string;
	readonly workingTreeRevision: string;
	readonly indexChanges: readonly ParadisOfficeGitChange[];
	readonly workingTreeChanges: readonly ParadisOfficeGitChange[];
}

/** Minimal Git repository surface. `onDidChange` is the repository status/index event. */
export interface IParadisOfficeGitRepository {
	readonly snapshot: ParadisOfficeGitRepositorySnapshot;
	readonly onDidChange: Event<void>;
}

/** Workbench-owned byte provider. It deliberately exposes no fetch/smudge operation. */
export interface IParadisOfficeGitByteProvider {
	readFile(resource: URI, token: CancellationToken, maximumBytes: number): Promise<VSBuffer>;
}

export interface ParadisOfficeLfsPointer {
	readonly oid: string;
	readonly size: number;
}

export interface ParadisOfficeGitSourceSide {
	readonly descriptor: ParadisOfficeSourceDescriptor;
	readonly byteLength: number;
	readonly contentHash: string;
	readonly lfs?: ParadisOfficeLfsPointer;
}

export interface ParadisOfficeGitComparisonSources {
	readonly original: ParadisOfficeGitSourceSide;
	readonly modified: ParadisOfficeGitSourceSide;
	readonly outcome: Extract<ParadisOfficeOutcome, 'complete' | 'degraded' | 'sideMissing'>;
}

export class ParadisOfficeGitSourceError extends Error {
	override readonly name = 'ParadisOfficeGitSourceError';

	constructor(readonly code: 'invalidRepository' | 'invalidPath' | 'notFound' | 'changed' | 'cancelled' | 'limitExceeded') {
		super('The Git Office source could not be resolved.');
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
	}
}

const gitCommitPattern = /^[a-f\d]{40,64}$/i;
const indexChecksumPattern = /^[a-f\d]{64}$/i;
const lfsPointerPattern = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([a-f\d]{64})\r?\nsize (0|[1-9]\d*)\r?\n?$/i;
const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new ParadisOfficeGitSourceError('cancelled');
	}
}

function normalizeRelativePath(value: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
		throw new ParadisOfficeGitSourceError('invalidPath');
	}
	const segments = value.split('/');
	if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
		throw new ParadisOfficeGitSourceError('invalidPath');
	}
	return segments.join('/');
}

function snapshotRepository(repository: IParadisOfficeGitRepository): ParadisOfficeGitRepositorySnapshot {
	let snapshot: ParadisOfficeGitRepositorySnapshot;
	try {
		snapshot = repository.snapshot;
	} catch {
		throw new ParadisOfficeGitSourceError('invalidRepository');
	}
	if (!(snapshot.repositoryRoot instanceof URI)
		|| !gitCommitPattern.test(snapshot.headCommit)
		|| !indexChecksumPattern.test(snapshot.indexChecksum)
		|| typeof snapshot.workingTreeRevision !== 'string' || snapshot.workingTreeRevision.length < 1 || snapshot.workingTreeRevision.length > 4096
		|| !Array.isArray(snapshot.indexChanges) || !Array.isArray(snapshot.workingTreeChanges)) {
		throw new ParadisOfficeGitSourceError('invalidRepository');
	}
	return {
		repositoryRoot: snapshot.repositoryRoot,
		headCommit: snapshot.headCommit.toLowerCase(),
		indexChecksum: snapshot.indexChecksum.toLowerCase(),
		workingTreeRevision: snapshot.workingTreeRevision,
		indexChanges: snapshot.indexChanges.map(snapshotChange),
		workingTreeChanges: snapshot.workingTreeChanges.map(snapshotChange),
	};
}

function snapshotChange(change: ParadisOfficeGitChange): ParadisOfficeGitChange {
	if (!change || typeof change !== 'object' || !['added', 'modified', 'deleted', 'renamed'].includes(change.status)) {
		throw new ParadisOfficeGitSourceError('invalidRepository');
	}
	const path = normalizeRelativePath(change.path);
	const originalPath = change.originalPath === undefined ? undefined : normalizeRelativePath(change.originalPath);
	if (change.status === 'renamed' ? !originalPath || originalPath === path : originalPath !== undefined) {
		throw new ParadisOfficeGitSourceError('invalidRepository');
	}
	return { status: change.status, path, ...(originalPath ? { originalPath } : {}) };
}

function findChange(changes: readonly ParadisOfficeGitChange[], path: string): ParadisOfficeGitChange | undefined {
	return changes.find(change => change.path === path || change.originalPath === path);
}

function gitResource(resource: URI, ref: string): URI {
	const path = resource.scheme === 'file' ? resource.fsPath : resource.path;
	return resource.with({ scheme: 'git', query: JSON.stringify({ path, ref }), fragment: null });
}

function revisionField(value: string): string {
	return `${VSBuffer.fromString(value).byteLength}:${value}`;
}

function sourceRevision(kind: Exclude<ParadisOfficeSourceDescriptor['kind'], 'file' | 'remote' | 'untitled' | 'sideMissing'>, state: ParadisOfficeGitRepositorySnapshot, path: string, contentHash: string, immutableCommit?: string): string {
	const fields = kind === 'gitCommit'
		? [kind, state.repositoryRoot.toString(true), immutableCommit!, path, contentHash]
		: kind === 'gitIndex'
			? [kind, state.repositoryRoot.toString(true), state.headCommit, state.indexChecksum, path, contentHash]
			: [kind, state.repositoryRoot.toString(true), state.headCommit, state.indexChecksum, state.workingTreeRevision, path, contentHash];
	return `office-git-v1|${fields.map(revisionField).join('|')}`;
}

async function sha256(bytes: VSBuffer): Promise<string> {
	const owned = bytes.buffer.slice();
	const digest = await globalThis.crypto.subtle.digest('SHA-256', owned as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

function lfsPointer(bytes: VSBuffer): ParadisOfficeLfsPointer | undefined {
	if (bytes.byteLength > 1024) {
		return undefined;
	}
	const match = lfsPointerPattern.exec(bytes.toString());
	if (!match) {
		return undefined;
	}
	const size = Number(match[2]);
	if (!Number.isSafeInteger(size)) {
		return undefined;
	}
	return { oid: match[1].toLowerCase(), size };
}

function sideMissing(displayName: string, side: 'original' | 'modified'): ParadisOfficeGitSourceSide {
	return { descriptor: { kind: 'sideMissing', displayName, side }, byteLength: 0, contentHash: emptySha256 };
}

/** Creates immutable Git/index/working descriptors and also serves their exact raw bytes to SourceBroker. */
export class ParadisOfficeGitSource extends Disposable implements IOfficeSourceProvider {
	private readonly changeEmitter = this._register(new Emitter<void>());
	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly repository: IParadisOfficeGitRepository, private readonly byteProvider: IParadisOfficeGitByteProvider) {
		super();
		this._register(repository.onDidChange(() => this.changeEmitter.fire()));
	}

	async createComparison(kind: ParadisOfficeGitComparisonKind, requestedPath: string, token: CancellationToken): Promise<ParadisOfficeGitComparisonSources> {
		throwIfCancelled(token);
		const path = normalizeRelativePath(requestedPath);
		const state = snapshotRepository(this.repository);
		const change = findChange(kind === 'headToIndex' ? state.indexChanges : state.workingTreeChanges, path) ?? { status: 'modified', path } as const;
		const originalPath = change.status === 'renamed' ? change.originalPath! : change.path;
		const modifiedPath = change.path;
		const original = change.status === 'added'
			? sideMissing(requestedPath, 'original')
			: await this.createSide(kind === 'headToIndex' ? 'gitCommit' : 'gitIndex', originalPath, 'original', state, token);
		const modified = change.status === 'deleted'
			? sideMissing(requestedPath, 'modified')
			: await this.createSide(kind === 'headToIndex' ? 'gitIndex' : 'workingTree', modifiedPath, 'modified', state, token);
		const outcome = original.descriptor.kind === 'sideMissing' || modified.descriptor.kind === 'sideMissing'
			? 'sideMissing'
			: original.lfs || modified.lfs ? 'degraded' : 'complete';
		return { original, modified, outcome };
	}

	async snapshot(descriptor: ParadisOfficeSourceDescriptor): Promise<ParadisOfficeProviderSnapshot> {
		const state = snapshotRepository(this.repository);
		const { resource, path, ref } = this.parseDescriptor(descriptor, state);
		const bytes = await this.readOwned(resource, CancellationToken.None);
		const contentHash = await sha256(bytes);
		const revision = sourceRevision(descriptor.kind as 'gitCommit' | 'gitIndex' | 'workingTree', state, path, contentHash, ref);
		return { identity: `git:${state.repositoryRoot.toString(true)}`, revision };
	}

	async *read(descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): AsyncIterable<VSBuffer> {
		const state = snapshotRepository(this.repository);
		const { resource } = this.parseDescriptor(descriptor, state);
		yield await this.readOwned(resource, token);
	}

	private async createSide(kind: 'gitCommit' | 'gitIndex' | 'workingTree', path: string, side: 'original' | 'modified', state: ParadisOfficeGitRepositorySnapshot, token: CancellationToken): Promise<ParadisOfficeGitSourceSide> {
		const workingResource = URI.joinPath(state.repositoryRoot, ...path.split('/'));
		const ref = kind === 'gitCommit' ? state.headCommit : '';
		const resource = kind === 'workingTree' ? workingResource : gitResource(workingResource, ref);
		const bytes = await this.readOwned(resource, token);
		const contentHash = await sha256(bytes);
		throwIfCancelled(token);
		const revisionHint = sourceRevision(kind, state, path, contentHash, ref);
		const descriptor: ParadisOfficeSourceDescriptor = { kind, uri: resource.toString(true), revisionHint, displayName: path, side };
		const pointer = kind === 'workingTree' ? undefined : lfsPointer(bytes);
		return { descriptor, byteLength: bytes.byteLength, contentHash, ...(pointer ? { lfs: pointer } : {}) };
	}

	private parseDescriptor(descriptor: ParadisOfficeSourceDescriptor, state: ParadisOfficeGitRepositorySnapshot): { readonly resource: URI; readonly path: string; readonly ref?: string } {
		if ((descriptor.kind !== 'gitCommit' && descriptor.kind !== 'gitIndex' && descriptor.kind !== 'workingTree') || !descriptor.uri) {
			throw new ParadisOfficeGitSourceError('invalidPath');
		}
		let resource: URI;
		try {
			resource = URI.parse(descriptor.uri, true);
		} catch {
			throw new ParadisOfficeGitSourceError('invalidPath');
		}
		const rootPath = state.repositoryRoot.path.endsWith('/') ? state.repositoryRoot.path : `${state.repositoryRoot.path}/`;
		let absolutePath: string;
		let ref: string | undefined;
		if (descriptor.kind === 'workingTree') {
			absolutePath = resource.path;
			if (resource.scheme !== state.repositoryRoot.scheme || resource.authority !== state.repositoryRoot.authority) {
				throw new ParadisOfficeGitSourceError('invalidPath');
			}
		} else {
			if (resource.scheme !== 'git' || resource.authority !== state.repositoryRoot.authority) {
				throw new ParadisOfficeGitSourceError('invalidPath');
			}
			try {
				const query = JSON.parse(resource.query) as { readonly path?: unknown; readonly ref?: unknown };
				if (typeof query.path !== 'string' || typeof query.ref !== 'string' || Object.keys(query).length !== 2) {
					throw new Error();
				}
				absolutePath = URI.file(query.path).path;
				ref = query.ref;
			} catch {
				throw new ParadisOfficeGitSourceError('invalidPath');
			}
			if (descriptor.kind === 'gitCommit' ? !ref || !gitCommitPattern.test(ref) : ref !== '') {
				throw new ParadisOfficeGitSourceError('invalidPath');
			}
		}
		if (!absolutePath.startsWith(rootPath)) {
			throw new ParadisOfficeGitSourceError('invalidPath');
		}
		const path = normalizeRelativePath(absolutePath.slice(rootPath.length));
		return { resource, path, ...(ref === undefined ? {} : { ref }) };
	}

	private async readOwned(resource: URI, token: CancellationToken): Promise<VSBuffer> {
		throwIfCancelled(token);
		let bytes: VSBuffer;
		try {
			bytes = await this.byteProvider.readFile(resource, token, PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes);
		} catch (error) {
			if (token.isCancellationRequested) {
				throw new ParadisOfficeGitSourceError('cancelled');
			}
			if (error instanceof ParadisOfficeGitSourceError) {
				throw error;
			}
			throw new ParadisOfficeGitSourceError('notFound');
		}
		throwIfCancelled(token);
		if (!(bytes instanceof VSBuffer)) {
			throw new ParadisOfficeGitSourceError('notFound');
		}
		if (bytes.byteLength > PARADIS_OFFICE_BUDGET_PROFILES.desktopLocal.compressedInputBytes) {
			throw new ParadisOfficeGitSourceError('limitExceeded');
		}
		return VSBuffer.wrap(bytes.buffer.slice());
	}
}
