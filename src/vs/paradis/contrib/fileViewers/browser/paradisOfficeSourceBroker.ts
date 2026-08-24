/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { VSBuffer } from '../../../../base/common/buffer.js';
import type { CancellationToken } from '../../../../base/common/cancellation.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
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

/** Test-only runtime seam; it deliberately does not extend the broker's public options contract. */
interface ParadisOfficeSourceBrokerRuntimeOptions {
	readonly closeTimeout?: Readonly<{ setTimeout(runner: () => void, delay: number): unknown; clearTimeout(handle: unknown): void }>;
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

function runDependency<T>(token: CancellationToken, code: ParadisOfficeSourceBrokerErrorCode, dependency: () => T): T {
	throwIfCancelled(token);
	try {
		const result = dependency();
		throwIfCancelled(token);
		return result;
	} catch (error) {
		throwDependencyError(error, token, code);
	}
}

async function awaitDependency<T>(token: CancellationToken, code: ParadisOfficeSourceBrokerErrorCode, dependency: () => Promise<T> | T): Promise<T> {
	throwIfCancelled(token);
	try {
		const result = await dependency();
		throwIfCancelled(token);
		return result;
	} catch (error) {
		throwDependencyError(error, token, code);
	}
}

const brokerErrorCodes: readonly ParadisOfficeSourceBrokerErrorCode[] = ['stale', 'unsupportedSource', 'invalidProviderSnapshot', 'sourceTooLarge', 'providerFailure', 'hashFailure', 'spoolFailure', 'cleanupFailure', 'invalidChunk'];
const BOUNDED_OPERATION_MILLISECONDS = 250;

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
	constructor(private readonly options: ParadisOfficeSourceBrokerOptions & ParadisOfficeSourceBrokerRuntimeOptions) { }

	async open(untrustedDescriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<ParadisOfficeBackendSource> {
		const descriptor = runDependency(token, 'unsupportedSource', () => validateParadisOfficeSourceDescriptor(untrustedDescriptor));
		throwIfCancelled(token);
		const scheme = sourceScheme(descriptor);
		if (descriptor.kind === 'sideMissing') {
			return { kind: 'sideMissing', descriptor };
		}

		let remoteV1 = false;
		if ((descriptor.kind === 'remote' || descriptor.kind === 'workingTree') && scheme === 'vscode-remote') {
			const capability = runDependency(token, 'providerFailure', () => this.options.isRemoteProtocolV1({ ...descriptor }));
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
		const attemptId = generateUuid();
		let attemptCleanupPromise: Promise<void> | undefined;
		let cancellationCleanup: (() => Promise<void>) | undefined;
		const cancellationListener = token.onCancellationRequested(() => {
			if (cancellationCleanup) {
				void cancellationCleanup().catch(() => undefined);
			}
		});
		let writable: ReturnType<typeof validateParadisOfficeWritableSpoolReference>;
		let beginAttempt: ReturnType<typeof snapshotParadisOfficeSealedSpoolAttempt>;
		try {
			throwIfCancelled(token);
			cancellationCleanup = () => attemptCleanupPromise ??= this.disposeAttemptBounded(attemptId);
			const beginResult = await this.options.spoolClient.begin(this.options.ownerId, attemptId);
			if (token.isCancellationRequested) {
				await cancellationCleanup();
				throw newSafeCancellationError();
			}
			beginAttempt = snapshotParadisOfficeSealedSpoolAttempt(beginResult);
			if (token.isCancellationRequested) {
				await cancellationCleanup();
				throw newSafeCancellationError();
			}
			if (!beginAttempt.writable || beginAttempt.writable.ownerId !== this.options.ownerId || beginAttempt.writable.attemptId !== attemptId) {
				await cancellationCleanup();
				throw new ParadisOfficeSourceBrokerError('spoolFailure');
			}
			writable = beginAttempt.writable;
			let claimSucceeded = false;
			try {
				throwIfCancelled(token);
				await this.options.spoolClient.claim(writable, attemptId);
				claimSucceeded = true;
			} catch (error) {
				if (claimSucceeded) {
					await this.disposeReferenceBounded(writable);
				} else {
					await cancellationCleanup();
				}
				throwDependencyError(error, token, 'spoolFailure');
			}
			cancellationCleanup = () => this.disposeReferenceBounded(writable);
			throwIfCancelled(token);
		} catch (error) {
			if (cancellationCleanup) {
				await cancellationCleanup();
			}
			cancellationListener.dispose();
			throwDependencyError(error, token, 'spoolFailure');
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
		cancellationCleanup = () => this.awaitBounded(cleanup());
		let result: ParadisOfficeBackendSource | undefined;
		let failure: unknown;
		let iterator: AsyncIterator<VSBuffer> | undefined;
		let iteratorDone = false;
		try {
			throwIfCancelled(token);
			const hash = runDependency(token, 'hashFailure', () => this.options.createHash());
			let size = 0;
			const iterable = runDependency(token, 'providerFailure', () => this.options.provider.read(descriptor, token));
			iterator = runDependency(token, 'providerFailure', () => iterable[Symbol.asyncIterator]());
			while (true) {
				throwIfCancelled(token);
				let iteration: IteratorResult<VSBuffer>;
				try {
					iteration = await iterator.next();
				} catch (error) {
					throwDependencyError(error, token, 'providerFailure');
				}
				throwIfCancelled(token);
				let iterationSnapshot: ReturnType<typeof snapshotIteratorResult>;
				try {
					iterationSnapshot = snapshotIteratorResult(iteration);
				} catch (error) {
					throwDependencyError(error, token, 'providerFailure');
				}
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
					runDependency(token, 'hashFailure', () => hash.update(chunk));
					await awaitDependency(token, 'spoolFailure', () => this.options.spoolClient.append(writable, chunk));
				}
				size = nextSize;
			}
			throwIfCancelled(token);
			const sha256 = await awaitDependency(token, 'hashFailure', () => hash.digest());
			const beforeSeal = await this.providerSnapshot(descriptor, token);
			throwIfCancelled(token);
			if (before.identity !== beforeSeal.identity || before.revision !== beforeSeal.revision) {
				throw new ParadisOfficeSourceBrokerError('stale');
			}
			const revision = runDependency(token, 'hashFailure', () => buildParadisOfficeSourceRevision(sourceKind, before.identity, before.revision, size, sha256));
			const sealRequest = {
				sourceKind,
				providerIdentity: before.identity,
				providerRevision: before.revision,
				size,
				sha256,
				revision,
			} as const;
			const sealedResult = await awaitDependency(token, 'spoolFailure', () => this.options.spoolClient.seal(writable, sealRequest));
			let sealed: ReturnType<typeof validateParadisOfficeSealedSpoolReference>;
			try {
				sealed = validateParadisOfficeSealedSpoolReference(sealedResult);
			} catch (error) {
				throwDependencyError(error, token, 'spoolFailure');
			}
			throwIfCancelled(token);
			if (sealed.id !== writable.id || sealed.ownerId !== writable.ownerId || sealed.nonce !== writable.nonce || sealed.attemptId !== writable.attemptId
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
				await this.awaitBounded(cleanup());
			} catch {
				failure ??= new ParadisOfficeSourceBrokerError('cleanupFailure');
			}
		} else if (cleanupPromise) {
			try {
				await this.awaitBounded(cleanupPromise);
			} catch {
				failure ??= new ParadisOfficeSourceBrokerError('cleanupFailure');
			}
		}
		await this.closeIterator(iterator, iteratorDone);
		if (failure) {
			throwIfCancelled(token);
			throwBrokerError(failure, 'spoolFailure');
		}
		throwIfCancelled(token);
		return result!;
	}

	private async providerSnapshot(descriptor: ParadisOfficeSourceDescriptor, token: CancellationToken): Promise<ParadisOfficeProviderSnapshot> {
		const snapshot = await awaitDependency(token, 'providerFailure', () => this.options.provider.snapshot({ ...descriptor }));
		return runDependency(token, 'providerFailure', () => validateProviderSnapshot(snapshot));
	}

	private async disposeAttemptBounded(attemptId: string): Promise<void> {
		try {
			await this.awaitBounded(this.options.spoolClient.disposeAttempt(this.options.ownerId, attemptId));
		} catch {
			// A pre-response lease is owner-bound and cleanup must not replace cancellation.
		}
	}

	private async disposeReferenceBounded(reference: ReturnType<typeof validateParadisOfficeWritableSpoolReference>): Promise<void> {
		try {
			await this.awaitBounded(this.options.spoolClient.dispose(reference));
		} catch {
			// The reference was locally owner/attempt verified before this cleanup path.
		}
	}

	private async closeIterator(iterator: AsyncIterator<VSBuffer> | undefined, completed: boolean): Promise<void> {
		if (!iterator || completed) {
			return;
		}
		try {
			const close = iterator.return;
			if (typeof close === 'function') {
				const closing = Promise.resolve(close.call(iterator)).then(() => undefined);
				void closing.catch(() => undefined);
				await this.awaitBounded(closing);
			}
		} catch {
			// The primary broker outcome and cleanup ownership take precedence over provider close errors.
		}
	}

	private async awaitBounded(operation: Promise<unknown>): Promise<void> {
		const timeout = this.options.closeTimeout ?? { setTimeout, clearTimeout };
		const settling = Promise.resolve(operation).then(() => undefined);
		void settling.catch(() => undefined);
		let handle: unknown;
		const timedOut = new Promise<void>(resolve => handle = timeout.setTimeout(resolve, BOUNDED_OPERATION_MILLISECONDS));
		try {
			await Promise.race([settling, timedOut]);
		} finally {
			timeout.clearTimeout(handle);
		}
	}
}
