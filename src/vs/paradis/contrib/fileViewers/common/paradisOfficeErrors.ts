/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/** Processing boundary at which an Office operation failed. */
export type ParadisOfficeErrorStage = 'source' | 'container' | 'format' | 'engine' | 'transport' | 'render' | 'diff' | 'export';

/** Stable source error codes. */
export type ParadisOfficeSourceErrorCode = 'notFound' | 'permission' | 'changed' | 'sideMissing' | 'unsupportedScheme';

/** Stable package-container error codes. */
export type ParadisOfficeContainerErrorCode = 'invalid' | 'encrypted' | 'zipBomb' | 'limitExceeded';

/** Stable document-format error codes. */
export type ParadisOfficeFormatErrorCode = 'unsupported' | 'malformed' | 'featureUnsupported';

/** Stable parser/worker error codes. */
export type ParadisOfficeEngineErrorCode = 'libraryMissing' | 'versionMismatch' | 'engineCrashed';

/** Stable channel error codes. */
export type ParadisOfficeTransportErrorCode = 'timeout' | 'cancelled' | 'disconnected' | 'payloadTooLarge';

/** Stable renderer error codes. */
export type ParadisOfficeRenderErrorCode = 'cspBlocked' | 'workerFailed' | 'blank' | 'outOfMemory';

/** Stable comparison error codes. */
export type ParadisOfficeDiffErrorCode = 'partial' | 'truncated' | 'stale' | 'sideUnavailable';

/** Stable print/export error codes. */
export type ParadisOfficeExportErrorCode = 'printFailed' | 'unsupported';

/** Stage-to-code relationship used by the v1 wire contract. */
export interface ParadisOfficeErrorCodeByStage {
	readonly source: ParadisOfficeSourceErrorCode;
	readonly container: ParadisOfficeContainerErrorCode;
	readonly format: ParadisOfficeFormatErrorCode;
	readonly engine: ParadisOfficeEngineErrorCode;
	readonly transport: ParadisOfficeTransportErrorCode;
	readonly render: ParadisOfficeRenderErrorCode;
	readonly diff: ParadisOfficeDiffErrorCode;
	readonly export: ParadisOfficeExportErrorCode;
}

/** Stable Office error code independent of localized UI text. */
export type ParadisOfficeErrorCode = ParadisOfficeErrorCodeByStage[ParadisOfficeErrorStage];

/** Safe recovery actions understood by Office viewer clients. */
export type ParadisOfficeErrorUserAction =
	| 'none'
	| 'retry'
	| 'reopen'
	| 'requestAccess'
	| 'chooseAnotherFile'
	| 'reduceDocumentSize'
	| 'useLegacyViewer'
	| 'openExternally'
	| 'reconnect'
	| 'updateClient';

/** Non-path-bearing Part identity suitable for IPC and telemetry. */
export interface ParadisOfficeErrorPart {
	readonly safeId: string;
	readonly contentType?: string;
	readonly feature?: string;
}

/** Additional already-sanitized metadata accepted by the error factory. */
export interface ParadisOfficeErrorDetails {
	readonly severity: 'warning' | 'error' | 'fatal';
	readonly retryable: boolean;
	readonly recoverable: boolean;
	readonly userAction: ParadisOfficeErrorUserAction;
	readonly side?: 'original' | 'modified';
	readonly part?: ParadisOfficeErrorPart;
	readonly sanitizedCauseCode?: string;
}

/** Serializable error shape. It intentionally has no raw cause, path, secret, or stack field. */
export type ParadisOfficeErrorForStage<TStage extends ParadisOfficeErrorStage> = ParadisOfficeErrorDetails & {
	readonly stage: TStage;
	readonly code: ParadisOfficeErrorCodeByStage[TStage];
	readonly safeMessage: string;
};

/** Serializable v1 Office error. */
export type ParadisOfficeError = {
	readonly [TStage in ParadisOfficeErrorStage]: ParadisOfficeErrorForStage<TStage>;
}[ParadisOfficeErrorStage];

const safeMessages: Readonly<{ readonly [TStage in ParadisOfficeErrorStage]: Readonly<Record<ParadisOfficeErrorCodeByStage[TStage], string>> }> = {
	source: {
		notFound: 'The document could not be found.',
		permission: 'The document could not be read with the current permissions.',
		changed: 'The document changed while it was being read.',
		sideMissing: 'One side of the comparison is unavailable.',
		unsupportedScheme: 'This document source is not supported.',
	},
	container: {
		invalid: 'The document container is invalid.',
		encrypted: 'Encrypted Office documents cannot be processed.',
		zipBomb: 'The document was blocked because its compressed data is unsafe.',
		limitExceeded: 'The document exceeds the configured processing limit.',
	},
	format: {
		unsupported: 'This Office document format is not supported.',
		malformed: 'The Office document is malformed.',
		featureUnsupported: 'This Office document feature is not supported.',
	},
	engine: {
		libraryMissing: 'A required Office processing component is unavailable.',
		versionMismatch: 'The Office processing components are incompatible.',
		engineCrashed: 'The Office processing engine stopped unexpectedly.',
	},
	transport: {
		timeout: 'The Office operation timed out.',
		cancelled: 'The Office operation was cancelled.',
		disconnected: 'The Office processing service disconnected.',
		payloadTooLarge: 'The Office response exceeds the transport limit.',
	},
	render: {
		cspBlocked: 'The Office content was blocked by the viewer security policy.',
		workerFailed: 'The Office rendering worker stopped unexpectedly.',
		blank: 'The Office renderer produced no visible content.',
		outOfMemory: 'There was not enough memory to render the Office document.',
	},
	diff: {
		partial: 'The Office comparison is incomplete.',
		truncated: 'The Office comparison reached its processing limit.',
		stale: 'The Office comparison is based on an older document revision.',
		sideUnavailable: 'A comparison side is no longer available.',
	},
	export: {
		printFailed: 'The Office document could not be prepared for printing.',
		unsupported: 'This Office export format is not supported.',
	},
};

const validSeverities: readonly ParadisOfficeErrorDetails['severity'][] = ['warning', 'error', 'fatal'];
const validUserActions: readonly ParadisOfficeErrorUserAction[] = [
	'none', 'retry', 'reopen', 'requestAccess', 'chooseAnotherFile', 'reduceDocumentSize', 'useLegacyViewer', 'openExternally', 'reconnect', 'updateClient',
];
const safeIdentifierPattern = /^[A-Za-z][A-Za-z\d._-]{0,127}$/;
const safePartIdentifierPattern = /^[A-Za-z][A-Za-z\d._-]{0,63}:[A-Za-z\d][A-Za-z\d._-]{0,127}$/;
const safeContentTypePattern = /^[a-z\d][a-z\d.+-]{0,63}\/[a-z\d][a-z\d.+-]{0,127}$/;

type ParadisOfficeErrorIdentity = {
	readonly [TStage in ParadisOfficeErrorStage]: {
		readonly stage: TStage;
		readonly code: ParadisOfficeErrorCodeByStage[TStage];
		readonly safeMessage: string;
	};
}[ParadisOfficeErrorStage];

function isDataDescriptor(descriptor: PropertyDescriptor | undefined): descriptor is PropertyDescriptor & { readonly value: unknown } {
	return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, 'value');
}

function getPlainDescriptors(value: unknown): Readonly<Record<string, PropertyDescriptor>> | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			return undefined;
		}
		return Object.getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
}

function getDataValue(descriptors: Readonly<Record<string, PropertyDescriptor>>, name: string): unknown {
	const descriptor = descriptors[name];
	return isDataDescriptor(descriptor) ? descriptor.value : undefined;
}

function projectSafePart(value: unknown): ParadisOfficeErrorPart | undefined {
	const descriptors = getPlainDescriptors(value);
	if (!descriptors) {
		return undefined;
	}
	const safeId = getDataValue(descriptors, 'safeId');
	const contentType = getDataValue(descriptors, 'contentType');
	const feature = getDataValue(descriptors, 'feature');
	if (typeof safeId !== 'string' || !safePartIdentifierPattern.test(safeId)
		|| (contentType !== undefined && (typeof contentType !== 'string' || !safeContentTypePattern.test(contentType)))
		|| (feature !== undefined && (typeof feature !== 'string' || !safeIdentifierPattern.test(feature)))) {
		return undefined;
	}
	return {
		safeId,
		...(typeof contentType === 'string' ? { contentType } : {}),
		...(typeof feature === 'string' ? { feature } : {}),
	};
}

function messageForStage<TStage extends ParadisOfficeErrorStage>(
	stage: TStage,
	code: unknown,
	messages: Readonly<Record<ParadisOfficeErrorCodeByStage[TStage], string>>,
): { readonly stage: TStage; readonly code: ParadisOfficeErrorCodeByStage[TStage]; readonly safeMessage: string } {
	if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(messages, code)) {
		throw new TypeError('Invalid Office error code for stage');
	}
	const correlatedCode = code as ParadisOfficeErrorCodeByStage[TStage];
	return { stage, code: correlatedCode, safeMessage: messages[correlatedCode] };
}

function messageFor(stage: unknown, code: unknown): ParadisOfficeErrorIdentity {
	switch (stage) {
		case 'source': return messageForStage(stage, code, safeMessages.source);
		case 'container': return messageForStage(stage, code, safeMessages.container);
		case 'format': return messageForStage(stage, code, safeMessages.format);
		case 'engine': return messageForStage(stage, code, safeMessages.engine);
		case 'transport': return messageForStage(stage, code, safeMessages.transport);
		case 'render': return messageForStage(stage, code, safeMessages.render);
		case 'diff': return messageForStage(stage, code, safeMessages.diff);
		case 'export': return messageForStage(stage, code, safeMessages.export);
		default: throw new TypeError('Invalid Office error stage');
	}
}

/** Creates an IPC-safe error without accepting or retaining raw exception data. */
export function createParadisOfficeError<TStage extends ParadisOfficeErrorStage>(
	stage: TStage,
	code: ParadisOfficeErrorCodeByStage[TStage],
	details: ParadisOfficeErrorDetails,
): ParadisOfficeErrorForStage<TStage>;
export function createParadisOfficeError(stage: unknown, code: unknown, details: unknown): ParadisOfficeError {
	const identity = messageFor(stage, code);
	const descriptors = getPlainDescriptors(details);
	if (!descriptors) {
		throw new TypeError('Invalid Office error details');
	}
	const severity = getDataValue(descriptors, 'severity');
	const retryable = getDataValue(descriptors, 'retryable');
	const recoverable = getDataValue(descriptors, 'recoverable');
	const userAction = getDataValue(descriptors, 'userAction');
	const side = getDataValue(descriptors, 'side');
	if (typeof severity !== 'string' || !validSeverities.includes(severity as ParadisOfficeErrorDetails['severity'])
		|| typeof retryable !== 'boolean'
		|| typeof recoverable !== 'boolean'
		|| typeof userAction !== 'string' || !validUserActions.includes(userAction as ParadisOfficeErrorUserAction)
		|| (side !== undefined && side !== 'original' && side !== 'modified')) {
		throw new TypeError('Invalid Office error details');
	}
	const part = projectSafePart(getDataValue(descriptors, 'part'));
	const sanitizedCauseCode = getDataValue(descriptors, 'sanitizedCauseCode');
	const projectedSide: ParadisOfficeErrorDetails['side'] = side === 'original' || side === 'modified' ? side : undefined;
	const projectedDetails = {
		severity: severity as ParadisOfficeErrorDetails['severity'],
		retryable,
		recoverable,
		userAction: userAction as ParadisOfficeErrorUserAction,
		...(projectedSide ? { side: projectedSide } : {}),
		...(part ? { part } : {}),
		...(typeof sanitizedCauseCode === 'string' && safeIdentifierPattern.test(sanitizedCauseCode) ? { sanitizedCauseCode } : {}),
	};
	switch (identity.stage) {
		case 'source': return { ...identity, ...projectedDetails };
		case 'container': return { ...identity, ...projectedDetails };
		case 'format': return { ...identity, ...projectedDetails };
		case 'engine': return { ...identity, ...projectedDetails };
		case 'transport': return { ...identity, ...projectedDetails };
		case 'render': return { ...identity, ...projectedDetails };
		case 'diff': return { ...identity, ...projectedDetails };
		case 'export': return { ...identity, ...projectedDetails };
	}
}
