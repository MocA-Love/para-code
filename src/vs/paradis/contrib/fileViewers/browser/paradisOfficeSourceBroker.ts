/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
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
	snapshotParadisOfficeBuffer,
	snapshotParadisOfficeSealedSpoolAttempt,
	validateParadisOfficeSealedSpoolReference,
	validateParadisOfficeSourceDescriptor,
	validateParadisOfficeWritableSpoolReference,
} from '../common/paradisOfficeSourceBroker.js';
import { PARADIS_OFFICE_BUDGET_PROFILES, type ParadisOfficeBudgetProfile } from '../common/paradisOfficeProtocol.js';

export type ParadisOfficeSourceBrokerErrorCode =
	| 'stale'
	| 'unsupportedSource'
	| 'invalidProviderSnapshot'
	| 'sourceTooLarge'
	| 'providerFailure'
	| 'hashFailure'
	| 'spoolFailure'
	| 'cleanupFailure'
	| 'invalidChunk';

export class ParadisOfficeSourceBrokerError extends Error {
	override readonly name = 'ParadisOfficeSourceBrokerError';
	readonly code: ParadisOfficeSourceBrokerErrorCode;

	constructor(code: ParadisOfficeSourceBrokerErrorCode) {
		const safeCode = brokerErrorCodes.includes(code) ? code : 'spoolFailure';
		super(safeCode === 'stale' ? 'The Office source changed while it was being read.' : 'The Office source could not be brokered.');
		this.code = safeCode;
		Object.defineProperty(this, 'stack', { configurable: true, value: '' });
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
		throw newSafeCancellationError();
	}
}

function newSafeCancellationError(): CancellationError {
	const error = new CancellationError();
	Object.defineProperty(error, 'stack', { configurable: true, value: '' });
	return error;
}

function throwBrokerError(error: unknown, code: ParadisOfficeSourceBrokerErrorCode): never {
	if (isSafeCancellationError(error)) {
		throw newSafeCancellationError();
	}
	const brokerCode = safeBrokerErrorCode(error);
	if (brokerCode) {
		throw new ParadisOfficeSourceBrokerError(brokerCode);
	}
	throw new ParadisOfficeSourceBrokerError(code);
}

function throwDependencyError(error: unknown, token: CancellationToken, code: ParadisOfficeSourceBrokerErrorCode): never {
	if (token.isCancellationRequested) {
		throw newSafeCancellationError();
	}
	throwBrokerError(error, code);
}

const brokerErrorCodes: readonly ParadisOfficeSourceBrokerErrorCode[] = ['stale', 'unsupportedSource', 'invalidProviderSnapshot', 'sourceTooLarge', 'providerFailure', 'hashFailure', 'spoolFailure', 'cleanupFailure', 'invalidChunk'];

function safeBrokerErrorCode(value: unknown): ParadisOfficeSourceBrokerErrorCode | undefined {
	try {
		if (!(value instanceof ParadisOfficeSourceBrokerError)) {
			return undefined;
		}
		return brokerErrorCodes.includes(value.code) ? value.code : undefined;
	} catch {
		return undefined;
	}
}

function isSafeCancellationError(value: unknown): boolean {
	try {
		return isCancellationError(value);
	} catch {
		return false;
	}
}

function isSafeRangeError(value: unknown): boolean {
	try {
		return value instanceof RangeError;
	} catch {
		return false;
	}
}

function snapshotIteratorResult(value: unknown): { readonly done: boolean; readonly value?: unknown } {
	try {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new TypeError();
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 2 || !keys.includes('done') || !keys.includes('value')) {
			throw new TypeError();
		}
		const done = Object.getOwnPropertyDescriptor(value, 'done');
		const item = Object.getOwnPropertyDescriptor(value, 'value');
		if (!done?.enumerable || !Object.prototype.hasOwnProperty.call(done, 'value') || typeof done.value !== 'boolean'
			|| !item?.enumerable || !Object.prototype.hasOwnProperty.call(item, 'value')) {
			throw new TypeError();
		}
		return done.value ? { done: true } : { done: false, value: item.value };
	} catch {
		throw new ParadisOfficeSourceBrokerError('providerFailure');
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
		const code = safeBrokerErrorCode(error);
		if (code) {
			throw new ParadisOfficeSourceBrokerError(code);
		}
		throw new ParadisOfficeSourceBrokerError('invalidProviderSnapshot');
	}
}

function sourceScheme(descriptor: ParadisOfficeSourceDescriptor): string | undefined {
	if (descriptor.kind === 'sideMissing') {
		if (descriptor.uri !== undefined || descriptor.side === undefined) {
			throw new ParadisOfficeSourceBrokerError('unsupportedSource');
		}
		return undefined;
	}
	if (!descriptor.uri) {
		throw new ParadisOfficeSourceBrokerError('unsupportedSource');
	}
	let scheme: string;
	try {
		scheme = URI.parse(descriptor.uri, true).scheme;
	} catch {
		throw new ParadisOfficeSourceBrokerError('unsupportedSource');
	}
	const valid = descriptor.kind === 'file' ? scheme === 'file'
		: descriptor.kind === 'remote' ? scheme === 'vscode-remote'
			: descriptor.kind === 'workingTree' ? scheme === 'file' || scheme === 'vscode-remote'
				: descriptor.kind === 'gitCommit' || descriptor.kind === 'gitIndex' ? scheme === 'git'
					: descriptor.kind === 'untitled' ? scheme === 'untitled'
						: false;
	if (!valid) {
		throw new ParadisOfficeSourceBrokerError('unsupportedSource');
	}
	return scheme;
}

function directBackend(descriptor: ParadisOfficeSourceDescriptor, scheme: string, remoteV1: boolean): 'local' | 'remote' | undefined {
	if ((descriptor.kind === 'file' || descriptor.kind === 'workingTree') && scheme === 'file') {
		return 'local';
	}
	if ((descriptor.kind === 'remote' || descriptor.kind === 'workingTree') && scheme === 'vscode-remote' && remoteV1) {
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
		case 'workingTree':
			return descriptor.kind;
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
		const scheme = sourceScheme(descriptor);
		if (descriptor.kind === 'sideMissing') {
			return { kind: 'sideMissing', descriptor };
		}

		let remoteV1 = false;
		if ((descriptor.kind === 'remote' || descriptor.kind === 'workingTree') && scheme === 'vscode-remote') {
			let capability: unknown;
			try {
				capability = this.options.isRemoteProtocolV1({ ...descriptor });
			} catch (error) {
				throwBrokerError(error, 'providerFailure');
			}
			if (typeof capability !== 'boolean') {
				throw new ParadisOfficeSourceBrokerError('providerFailure');
			}
			remoteV1 = capability === true;
		}
		const backend = directBackend(descriptor, scheme!, remoteV1);
		if (backend) {
			return { kind: 'direct', backend, protocolVersion: 1, descriptor: { ...descriptor } };
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
		const before = await this.providerSnapshot(descriptor, token);
		throwIfCancelled(token);
		let writable: ReturnType<typeof validateParadisOfficeWritableSpoolReference>;
		try {
			const beginAttempt = snapshotParadisOfficeSealedSpoolAttempt(await this.options.spoolClient.begin(this.options.ownerId));
			if (!beginAttempt.writable) {
				if (beginAttempt.identity) {
					await this.disposeIgnoredSpool(beginAttempt.identity);
				}
				throw new ParadisOfficeSourceBrokerError('spoolFailure');
			}
			writable = beginAttempt.writable;
		} catch (error) {
			throwBrokerError(error, 'spoolFailure');
		}
		let keepSpool = false;
		let cleanupPromise: Promise<void> | undefined;
		const cleanup = (): Promise<void> => {
			if (!cleanupPromise) {
				try {
					cleanupPromise = Promise.resolve(this.options.spoolClient.dispose(writable));
				} catch {
					cleanupPromise = Promise.reject(new ParadisOfficeSourceBrokerError('cleanupFailure'));
				}
			}
			return cleanupPromise;
		};
		const cancellationListener = token.onCancellationRequested(() => {
			cleanup().catch(() => undefined);
		});
		let result: ParadisOfficeBackendSource | undefined;
		let failure: unknown;
		let iterator: AsyncIterator<VSBuffer> | undefined;
		let iteratorDone = false;
		try {
			throwIfCancelled(token);
			let hash: IOfficeSourceHash;
			try {
				hash = this.options.createHash();
			} catch (error) {
				throwDependencyError(error, token, 'hashFailure');
			}
			throwIfCancelled(token);
			let size = 0;
			try {
				iterator = this.options.provider.read(descriptor, token)[Symbol.asyncIterator]();
			} catch (error) {
				throwBrokerError(error, 'providerFailure');
			}
			while (true) {
				throwIfCancelled(token);
				let iteration: IteratorResult<VSBuffer>;
				try {
					iteration = await iterator.next();
				} catch (error) {
					throwDependencyError(error, token, 'providerFailure');
				}
				throwIfCancelled(token);
				const iterationSnapshot = snapshotIteratorResult(iteration);
				throwIfCancelled(token);
				if (iterationSnapshot.done) {
					iteratorDone = true;
					break;
				}
				const remainingBytes = PARADIS_OFFICE_BUDGET_PROFILES[this.options.platform].compressedInputBytes - size;
				let providerBytes: VSBuffer;
				try {
					providerBytes = snapshotParadisOfficeBuffer(iterationSnapshot.value, remainingBytes);
				} catch (error) {
					if (token.isCancellationRequested) {
						throw newSafeCancellationError();
					}
					throw new ParadisOfficeSourceBrokerError(isSafeRangeError(error) ? 'sourceTooLarge' : 'invalidChunk');
				}
				throwIfCancelled(token);
				const nextSize = size + providerBytes.byteLength;
				if (!Number.isSafeInteger(nextSize)) {
					throw new ParadisOfficeSourceBrokerError('sourceTooLarge');
				}
				for (let offset = 0; offset < providerBytes.byteLength; offset += PARADIS_OFFICE_SPOOL_CHUNK_BYTES) {
					const chunk = providerBytes.slice(offset, Math.min(offset + PARADIS_OFFICE_SPOOL_CHUNK_BYTES, providerBytes.byteLength));
					try {
						hash.update(chunk);
					} catch (error) {
						throwDependencyError(error, token, 'hashFailure');
					}
					throwIfCancelled(token);
					try {
						await this.options.spoolClient.append(writable, chunk);
					} catch (error) {
						throwDependencyError(error, token, 'spoolFailure');
					}
					throwIfCancelled(token);
				}
				size = nextSize;
			}
			throwIfCancelled(token);
			let sha256: string;
			try {
				sha256 = await hash.digest();
			} catch (error) {
				throwDependencyError(error, token, 'hashFailure');
			}
			throwIfCancelled(token);
			const beforeSeal = await this.providerSnapshot(descriptor, token);
			throwIfCancelled(token);
			if (before.identity !== beforeSeal.identity || before.revision !== beforeSeal.revision) {
				throw new ParadisOfficeSourceBrokerError('stale');
			}
			let revision: string;
			try {
				revision = buildParadisOfficeSourceRevision(sourceKind, before.identity, before.revision, size, sha256);
			} catch (error) {
				throwDependencyError(error, token, 'hashFailure');
			}
			const sealRequest = {
				sourceKind,
				providerIdentity: before.identity,
				providerRevision: before.revision,
				size,
				sha256,
				revision,
			} as const;
			let sealed: ReturnType<typeof validateParadisOfficeSealedSpoolReference>;
			try {
				sealed = validateParadisOfficeSealedSpoolReference(await this.options.spoolClient.seal(writable, sealRequest));
			} catch (error) {
				throwDependencyError(error, token, 'spoolFailure');
			}
			if (sealed.id !== writable.id || sealed.ownerId !== writable.ownerId || sealed.nonce !== writable.nonce
				|| sealed.sourceKind !== sealRequest.sourceKind || sealed.providerIdentity !== sealRequest.providerIdentity
				|| sealed.providerRevision !== sealRequest.providerRevision || sealed.size !== sealRequest.size
				|| sealed.sha256 !== sealRequest.sha256 || sealed.revision !== sealRequest.revision) {
				throw new ParadisOfficeSourceBrokerError('spoolFailure');
			}
			throwIfCancelled(token);
			const afterSeal = await this.providerSnapshot(descriptor, token);
			throwIfCancelled(token);
			if (before.identity !== afterSeal.identity || before.revision !== afterSeal.revision) {
				throw new ParadisOfficeSourceBrokerError('stale');
			}
			keepSpool = true;
			result = { kind: 'spool', descriptor: { ...descriptor }, spool: sealed };
		} catch (error) {
			failure = error;
		}
		cancellationListener.dispose();
		if (!keepSpool) {
			try {
				await cleanup();
			} catch {
				failure ??= new ParadisOfficeSourceBrokerError('cleanupFailure');
			}
		} else if (cleanupPromise) {
			try {
				await cleanupPromise;
			} catch {
				failure ??= new ParadisOfficeSourceBrokerError('cleanupFailure');
			}
		}
		await this.closeIterator(iterator, iteratorDone);
		if (failure) {
			throwBrokerError(failure, 'spoolFailure');
		}
		return result!;
	}

	private async providerSnapshot(descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<ParadisOfficeProviderSnapshot> {
		throwIfCancelled(token);
		try {
			const snapshot = validateProviderSnapshot(await this.options.provider.snapshot({ ...descriptor }));
			throwIfCancelled(token);
			return snapshot;
		} catch (error) {
			throwDependencyError(error, token, 'providerFailure');
		}
	}

	private async disposeIgnoredSpool(reference: ReturnType<typeof validateParadisOfficeWritableSpoolReference>): Promise<void> {
		try {
			await this.options.spoolClient.dispose(reference);
		} catch {
			// An invalid begin response must not retain a capability even if its peer is already gone.
		}
	}

	private async closeIterator(iterator: AsyncIterator<VSBuffer> | undefined, completed: boolean): Promise<void> {
		if (!iterator || completed) {
			return;
		}
		try {
			const close = iterator.return;
			if (typeof close === 'function') {
				const closing = Promise.resolve(close.call(iterator));
				void closing.catch(() => undefined);
				await Promise.race([closing, new Promise<void>(resolve => setTimeout(resolve, 250))]);
			}
		} catch {
			// The primary broker outcome and cleanup ownership take precedence over provider close errors.
		}
	}
}
