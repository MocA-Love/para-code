/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { createHash } from 'crypto';
import { open } from 'fs/promises';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeBudgetProfile, type ParadisOfficeSourceDescriptor } from '../common/paradisOfficeProtocol.js';
import { OfficeHandleStore } from './office/paradisOfficeHandleStore.js';
import { OfficeMemoryAccountant, OfficeWorkerHost, type OfficeWorkerBytesSource, type OfficeWorkerHostOptions, type OfficeWorkerOutcome, type OfficeWorkerSource, type ParadisOfficeWorkerOperation } from './office/paradisOfficeWorkerHost.js';
import {
	LocalParadisOfficeDocumentBackend,
	ParadisOfficeSourceResolutionError,
	type IParadisOfficeChannelSourceResolver,
	type IParadisOfficeFileHandle,
	type IParadisOfficeFileStat,
} from './paradisOfficeChannel.js';

export interface ParadisOfficeRemoteSourceResolverOptions {
	readonly openFile?: (path: string) => Promise<IParadisOfficeFileHandle>;
	readonly fileCoordinator?: ParadisOfficeRemoteFileCoordinator;
}

const authorityPattern = /^[A-Za-z\d][A-Za-z\d._+:-]{0,511}$/;
const hintPattern = /^[\u0020-\u007e]{1,4096}$/;
const readChunkBytes = 2 * 1024 * 1024;

function sameStat(left: IParadisOfficeFileStat, right: IParadisOfficeFileStat): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.ctimeMs === right.ctimeMs && left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function validStat(stat: IParadisOfficeFileStat): boolean {
	return stat.isFile() && Number.isSafeInteger(stat.size) && stat.size >= 0
		&& [stat.dev, stat.ino, stat.ctimeMs, stat.mtimeMs].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function revisionField(value: string): string {
	return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

/** Opens vscode-remote descriptors on the server and gives workers only owned raw bytes. */
export class ParadisOfficeRemoteSourceResolver implements IParadisOfficeChannelSourceResolver {
	private readonly openFile: (path: string) => Promise<IParadisOfficeFileHandle>;
	private readonly fileCoordinator: ParadisOfficeRemoteFileCoordinator;

	constructor(private readonly remoteAuthority: string, options: ParadisOfficeRemoteSourceResolverOptions = {}) {
		if (!authorityPattern.test(remoteAuthority)) {
			throw new ParadisOfficeSourceResolutionError('unsupportedScheme');
		}
		this.openFile = options.openFile ?? (path => open(path, 'r'));
		this.fileCoordinator = options.fileCoordinator ?? new ParadisOfficeRemoteFileCoordinator();
	}

	async resolve(ownerId: string, descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<OfficeWorkerBytesSource> {
		if ((descriptor.kind !== 'remote' && descriptor.kind !== 'workingTree') || !descriptor.uri
			|| descriptor.revisionHint !== undefined && !hintPattern.test(descriptor.revisionHint)) {
			throw new ParadisOfficeSourceResolutionError('unsupportedScheme');
		}
		let resource: URI;
		try {
			resource = URI.parse(descriptor.uri, true);
		} catch {
			throw new ParadisOfficeSourceResolutionError('unsupportedScheme');
		}
		const segments = resource.path.split('/');
		if (resource.scheme !== 'vscode-remote' || resource.authority !== this.remoteAuthority || !resource.path.startsWith('/')
			|| resource.query !== '' || resource.fragment !== '' || resource.path.includes('\0') || resource.path.includes('\\')
			|| segments.some((segment, index) => index > 0 && (segment === '' || segment === '.' || segment === '..')) || token.isCancellationRequested) {
			throw new ParadisOfficeSourceResolutionError('unsupportedScheme');
		}
		this.fileCoordinator.acquire(ownerId);
		let handle: IParadisOfficeFileHandle | undefined;
		try {
			handle = await this.openFile(resource.fsPath);
			if (token.isCancellationRequested) {
				throw new ParadisOfficeSourceResolutionError('changed');
			}
			const before = await handle.stat();
			if (!validStat(before)) {
				throw new ParadisOfficeSourceResolutionError('changed');
			}
			if (before.size > PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile.compressedInputBytes) {
				throw new ParadisOfficeSourceResolutionError('limitExceeded');
			}
			const bytes = new Uint8Array(before.size);
			const hash = createHash('sha256');
			for (let position = 0; position < before.size;) {
				const length = Math.min(readChunkBytes, before.size - position);
				const result = await handle.read(bytes, position, length, position);
				if (token.isCancellationRequested || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 1 || result.bytesRead > length) {
					throw new ParadisOfficeSourceResolutionError('changed');
				}
				hash.update(bytes.subarray(position, position + result.bytesRead));
				position += result.bytesRead;
			}
			const growthProbe = new Uint8Array(1);
			const growth = await handle.read(growthProbe, 0, 1, before.size);
			const after = await handle.stat();
			if (token.isCancellationRequested || growth.bytesRead !== 0 || !validStat(after) || !sameStat(before, after)) {
				throw new ParadisOfficeSourceResolutionError('changed');
			}
			const contentHash = hash.digest('hex');
			const revision = `office-remote-v1|${[
				descriptor.kind,
				this.remoteAuthority,
				resource.path,
				descriptor.revisionHint ?? '',
				`${after.dev}:${after.ino}:${after.ctimeMs}:${after.mtimeMs}:${after.size}`,
				contentHash,
			].map(revisionField).join('|')}`;
			return { kind: 'bytes', bytes, revision };
		} catch (error) {
			if (error instanceof ParadisOfficeSourceResolutionError) {
				throw error;
			}
			const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
			if (code === 'ENOENT') {
				throw new ParadisOfficeSourceResolutionError('notFound');
			}
			if (code === 'EACCES' || code === 'EPERM') {
				throw new ParadisOfficeSourceResolutionError('permission');
			}
			throw new ParadisOfficeSourceResolutionError('unsupportedScheme');
		} finally {
			try {
				await handle?.close();
			} catch {
				// Resolution outcome takes precedence over close failures.
			}
			this.fileCoordinator.release(ownerId);
		}
	}
}

/** One registration-wide descriptor/file admission ledger shared by every connection. */
export class ParadisOfficeRemoteFileCoordinator {
	private openFiles = 0;
	private readonly ownerOpenFiles = new Map<string, number>();

	acquire(ownerId: string): void {
		const ownerCount = this.ownerOpenFiles.get(ownerId) ?? 0;
		if (this.openFiles >= 8 || ownerCount >= 2) { throw new ParadisOfficeSourceResolutionError('limitExceeded'); }
		this.openFiles++;
		this.ownerOpenFiles.set(ownerId, ownerCount + 1);
	}

	release(ownerId: string): void {
		const ownerCount = this.ownerOpenFiles.get(ownerId) ?? 0;
		if (ownerCount < 1) { return; }
		this.openFiles = Math.max(0, this.openFiles - 1);
		const next = ownerCount - 1;
		if (next === 0) { this.ownerOpenFiles.delete(ownerId); } else { this.ownerOpenFiles.set(ownerId, next); }
	}
}

/** Forces Task 6 calls through the normative remote/mobile budget, regardless of facade defaults. */
export class ParadisOfficeRemoteWorkerHost extends OfficeWorkerHost {
	constructor(options: OfficeWorkerHostOptions = {}) { super(options); }
	override run<T extends object>(operation: ParadisOfficeWorkerOperation, ownerId: string, source: OfficeWorkerSource, _budget: ParadisOfficeBudgetProfile, token: CancellationToken, options: { readonly reservationBytes?: number; readonly workerId?: string } = {}): Promise<OfficeWorkerOutcome<T>> {
		return super.run<T>(operation, ownerId, source, PARADIS_OFFICE_BUDGET_PROFILES.remoteMobile, token, options);
	}
}

/** Remote backend facade. The Task 6 backend receives resolver-owned bytes, never a URI. */
export class ParadisOfficeRemoteBackend extends LocalParadisOfficeDocumentBackend {
	constructor(remoteAuthority: string, options: ParadisOfficeRemoteSourceResolverOptions = {}, dependencies = createRemoteDependencies(remoteAuthority, options)) {
		super(dependencies.resolver, dependencies.workers, dependencies.handles);
	}
}

/** Registration-owned remote resources; connections contribute only owner/epoch state. */
export class ParadisOfficeRemoteRuntime implements IDisposable {
	readonly accountant = new OfficeMemoryAccountant(768 * 1024 * 1024);
	readonly handles = new OfficeHandleStore({ accountant: this.accountant });
	readonly workers = new ParadisOfficeRemoteWorkerHost({ accountant: this.accountant, onWorkerCrashed: workerId => this.handles.invalidateWorker(workerId) });
	readonly files = new ParadisOfficeRemoteFileCoordinator();

	createBackend(remoteAuthority: string, options: ParadisOfficeRemoteSourceResolverOptions = {}): ParadisOfficeRemoteBackend {
		const resolver = new ParadisOfficeRemoteSourceResolver(remoteAuthority, { ...options, fileCoordinator: this.files });
		return new ParadisOfficeRemoteBackend(remoteAuthority, options, { resolver, workers: this.workers, handles: this.handles });
	}

	dispose(): void { this.workers.dispose(); }
}

function createRemoteDependencies(remoteAuthority: string, options: ParadisOfficeRemoteSourceResolverOptions): {
	readonly resolver: ParadisOfficeRemoteSourceResolver;
	readonly workers: OfficeWorkerHost;
	readonly handles: OfficeHandleStore;
} {
	const accountant = new OfficeMemoryAccountant(768 * 1024 * 1024);
	const handles = new OfficeHandleStore({ accountant });
	const workers = new ParadisOfficeRemoteWorkerHost({ accountant, onWorkerCrashed: workerId => handles.invalidateWorker(workerId) });
	return { resolver: new ParadisOfficeRemoteSourceResolver(remoteAuthority, options), workers, handles };
}
