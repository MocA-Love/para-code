/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import {
	buildParadisOfficeSourceRevision,
	IOfficeSourceBroker,
	IOfficeSourceHash,
	IOfficeSourceProvider,
	IOfficeSpoolClient,
	PARADIS_OFFICE_SPOOL_CHUNK_BYTES,
	ParadisOfficeBackendSource,
	ParadisOfficeProviderSnapshot,
	ParadisOfficeSourceDescriptor,
	ParadisOfficeSpoolSourceKind,
	validateParadisOfficeSealedSpoolReference,
	validateParadisOfficeSourceDescriptor,
} from '../common/paradisOfficeSourceBroker.js';
import type { ParadisOfficeBudgetProfile } from '../common/paradisOfficeProtocol.js';

export type ParadisOfficeSourceBrokerErrorCode = 'stale' | 'unsupportedSource' | 'invalidProviderSnapshot' | 'sourceTooLarge';

export class ParadisOfficeSourceBrokerError extends Error {
	override readonly name = 'ParadisOfficeSourceBrokerError';

	constructor(readonly code: ParadisOfficeSourceBrokerErrorCode) {
		super(code === 'stale' ? 'The Office source changed while it was being read.' : 'The Office source could not be brokered.');
	}
}

export interface ParadisOfficeSourceBrokerOptions {
	readonly ownerId: string;
	readonly platform: ParadisOfficeBudgetProfile['kind'];
	readonly provider: IOfficeSourceProvider;
	readonly spoolClient: IOfficeSpoolClient;
	readonly createHash: () => IOfficeSourceHash;
	readonly isRemoteProtocolV1: (descriptor: ParadisOfficeSourceDescriptor) => boolean;
}

function throwIfCancelled(token: CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new CancellationError();
	}
}

function validateProviderSnapshot(value: unknown): ParadisOfficeProviderSnapshot {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ParadisOfficeSourceBrokerError('invalidProviderSnapshot');
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		const keys = Reflect.ownKeys(value);
		const identityDescriptor = Object.getOwnPropertyDescriptor(value, 'identity');
		const revisionDescriptor = Object.getOwnPropertyDescriptor(value, 'revision');
		if ((prototype !== Object.prototype && prototype !== null)
			|| keys.length !== 2 || !keys.includes('identity') || !keys.includes('revision')
			|| !identityDescriptor?.enumerable || !Object.prototype.hasOwnProperty.call(identityDescriptor, 'value')
			|| !revisionDescriptor?.enumerable || !Object.prototype.hasOwnProperty.call(revisionDescriptor, 'value')
			|| typeof identityDescriptor.value !== 'string' || identityDescriptor.value.length === 0 || identityDescriptor.value.length > 4096
			|| typeof revisionDescriptor.value !== 'string' || revisionDescriptor.value.length === 0 || revisionDescriptor.value.length > 4096) {
			throw new ParadisOfficeSourceBrokerError('invalidProviderSnapshot');
		}
		return { identity: identityDescriptor.value, revision: revisionDescriptor.value };
	} catch (error) {
		if (error instanceof ParadisOfficeSourceBrokerError) {
			throw error;
		}
		throw new ParadisOfficeSourceBrokerError('invalidProviderSnapshot');
	}
}

function directBackend(descriptor: ParadisOfficeSourceDescriptor, remoteV1: boolean): 'local' | 'remote' | undefined {
	const uri = descriptor.uri;
	if ((descriptor.kind === 'file' || descriptor.kind === 'workingTree') && uri?.startsWith('file:')) {
		return 'local';
	}
	if ((descriptor.kind === 'remote' || descriptor.kind === 'workingTree') && uri?.startsWith('vscode-remote:') && remoteV1) {
		return 'remote';
	}
	return undefined;
}

function spoolSourceKind(descriptor: ParadisOfficeSourceDescriptor): ParadisOfficeSpoolSourceKind | undefined {
	switch (descriptor.kind) {
		case 'remote':
		case 'gitCommit':
		case 'gitIndex':
		case 'untitled':
			return descriptor.kind;
		case 'workingTree':
			return descriptor.uri?.startsWith('vscode-remote:') ? 'remote' : undefined;
		default:
			return undefined;
	}
}

/** Routes provider-specific workbench sources without exposing provider capabilities to the backend. */
export class ParadisOfficeSourceBroker implements IOfficeSourceBroker {
	constructor(private readonly options: ParadisOfficeSourceBrokerOptions) { }

	async open(untrustedDescriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<ParadisOfficeBackendSource> {
		const descriptor = validateParadisOfficeSourceDescriptor(untrustedDescriptor);
		throwIfCancelled(token);
		if (descriptor.kind === 'sideMissing') {
			return { kind: 'sideMissing', descriptor };
		}

		const remoteV1 = (descriptor.kind === 'remote' || descriptor.kind === 'workingTree') && this.options.isRemoteProtocolV1(descriptor);
		const backend = directBackend(descriptor, remoteV1);
		if (backend) {
			return { kind: 'direct', backend, protocolVersion: 1, descriptor };
		}

		const sourceKind = spoolSourceKind(descriptor);
		if (!sourceKind) {
			throw new ParadisOfficeSourceBrokerError('unsupportedSource');
		}
		return this.spool(descriptor, sourceKind, token);
	}

	private async spool(
		descriptor: ParadisOfficeSourceDescriptor,
		sourceKind: ParadisOfficeSpoolSourceKind,
		token: CancellationToken,
	): Promise<ParadisOfficeBackendSource> {
		const before = validateProviderSnapshot(await this.options.provider.snapshot(descriptor));
		throwIfCancelled(token);
		const writable = await this.options.spoolClient.begin(this.options.ownerId);
		let keepSpool = false;
		let cleanupPromise: Promise<void> | undefined;
		const cleanup = (): Promise<void> => cleanupPromise ??= this.options.spoolClient.dispose(writable);
		const cancellationListener = token.onCancellationRequested(() => {
			cleanup().catch(() => undefined);
		});
		try {
			throwIfCancelled(token);
			const hash = this.options.createHash();
			let size = 0;
			for await (const providerChunk of this.options.provider.read(descriptor, token)) {
				throwIfCancelled(token);
				if (!(providerChunk instanceof VSBuffer)) {
					throw new TypeError('Invalid Office provider chunk');
				}
				for (let offset = 0; offset < providerChunk.byteLength; offset += PARADIS_OFFICE_SPOOL_CHUNK_BYTES) {
					throwIfCancelled(token);
					const chunk = providerChunk.slice(offset, Math.min(offset + PARADIS_OFFICE_SPOOL_CHUNK_BYTES, providerChunk.byteLength));
					if (!Number.isSafeInteger(size + chunk.byteLength)) {
						throw new ParadisOfficeSourceBrokerError('sourceTooLarge');
					}
					hash.update(chunk);
					await this.options.spoolClient.append(writable, chunk);
					size += chunk.byteLength;
				}
			}
			throwIfCancelled(token);
			const after = validateProviderSnapshot(await this.options.provider.snapshot(descriptor));
			throwIfCancelled(token);
			if (before.identity !== after.identity || before.revision !== after.revision) {
				throw new ParadisOfficeSourceBrokerError('stale');
			}
			const sha256 = await hash.digest();
			const revision = buildParadisOfficeSourceRevision(sourceKind, before.identity, before.revision, size, sha256);
			const sealRequest = {
				sourceKind,
				providerIdentity: before.identity,
				providerRevision: before.revision,
				size,
				sha256,
				revision,
			} as const;
			const sealed = validateParadisOfficeSealedSpoolReference(await this.options.spoolClient.seal(writable, sealRequest));
			if (sealed.id !== writable.id || sealed.ownerId !== writable.ownerId || sealed.nonce !== writable.nonce
				|| sealed.sourceKind !== sealRequest.sourceKind || sealed.providerIdentity !== sealRequest.providerIdentity
				|| sealed.providerRevision !== sealRequest.providerRevision || sealed.size !== sealRequest.size
				|| sealed.sha256 !== sealRequest.sha256 || sealed.revision !== sealRequest.revision) {
				throw new TypeError('Invalid sealed Office spool reference');
			}
			throwIfCancelled(token);
			keepSpool = true;
			return { kind: 'spool', descriptor, spool: sealed };
		} finally {
			cancellationListener.dispose();
			if (!keepSpool) {
				await cleanup();
			} else if (cleanupPromise) {
				await cleanupPromise;
			}
		}
	}
}
