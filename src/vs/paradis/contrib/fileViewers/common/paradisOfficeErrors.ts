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
export type ParadisOfficeFormatErrorCode = 'formatUnsupported' | 'malformed' | 'featureUnsupported';

/** Stable parser/worker error codes. */
export type ParadisOfficeEngineErrorCode = 'libraryMissing' | 'versionMismatch' | 'engineCrashed';

/** Stable channel error codes. */
export type ParadisOfficeTransportErrorCode = 'timeout' | 'cancelled' | 'disconnected' | 'payloadTooLarge';

/** Stable renderer error codes. */
export type ParadisOfficeRenderErrorCode = 'cspBlocked' | 'workerFailed' | 'blank' | 'outOfMemory';

/** Stable comparison error codes. */
export type ParadisOfficeDiffErrorCode = 'partial' | 'truncated' | 'stale' | 'sideUnavailable';

/** Stable print/export error codes. */
export type ParadisOfficeExportErrorCode = 'printFailed' | 'exportUnsupported';

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

const safeMessages: Readonly<Record<ParadisOfficeErrorCode, string>> = {
	notFound: 'The document could not be found.',
	permission: 'The document could not be read with the current permissions.',
	changed: 'The document changed while it was being read.',
	sideMissing: 'One side of the comparison is unavailable.',
	unsupportedScheme: 'This document source is not supported.',
	invalid: 'The document container is invalid.',
	encrypted: 'Encrypted Office documents cannot be processed.',
	zipBomb: 'The document was blocked because its compressed data is unsafe.',
	limitExceeded: 'The document exceeds the configured processing limit.',
	formatUnsupported: 'This Office document format is not supported.',
	malformed: 'The Office document is malformed.',
	featureUnsupported: 'This Office document feature is not supported.',
	libraryMissing: 'A required Office processing component is unavailable.',
	versionMismatch: 'The Office processing components are incompatible.',
	engineCrashed: 'The Office processing engine stopped unexpectedly.',
	timeout: 'The Office operation timed out.',
	cancelled: 'The Office operation was cancelled.',
	disconnected: 'The Office processing service disconnected.',
	payloadTooLarge: 'The Office response exceeds the transport limit.',
	cspBlocked: 'The Office content was blocked by the viewer security policy.',
	workerFailed: 'The Office rendering worker stopped unexpectedly.',
	blank: 'The Office renderer produced no visible content.',
	outOfMemory: 'There was not enough memory to render the Office document.',
	partial: 'The Office comparison is incomplete.',
	truncated: 'The Office comparison reached its processing limit.',
	stale: 'The Office comparison is based on an older document revision.',
	sideUnavailable: 'A comparison side is no longer available.',
	printFailed: 'The Office document could not be prepared for printing.',
	exportUnsupported: 'This Office export format is not supported.',
};

const safeIdentifierPattern = /^[A-Za-z][A-Za-z\d._-]{0,127}$/;
const safePartIdentifierPattern = /^[A-Za-z][A-Za-z\d._-]{0,63}:[A-Za-z\d][A-Za-z\d._-]{0,127}$/;
const safeContentTypePattern = /^[a-z\d][a-z\d.+-]{0,63}\/[a-z\d][a-z\d.+-]{0,127}$/;

function isSafeErrorPart(part: ParadisOfficeErrorPart): boolean {
	return safePartIdentifierPattern.test(part.safeId)
		&& (part.contentType === undefined || safeContentTypePattern.test(part.contentType))
		&& (part.feature === undefined || safeIdentifierPattern.test(part.feature));
}

/** Creates an IPC-safe error without accepting a raw exception or message. */
export function createParadisOfficeError<TStage extends ParadisOfficeErrorStage>(
	stage: TStage,
	code: ParadisOfficeErrorCodeByStage[TStage],
	details: ParadisOfficeErrorDetails,
): ParadisOfficeErrorForStage<TStage> {
	const { part, sanitizedCauseCode, ...safeDetails } = details;
	return {
		stage,
		code,
		safeMessage: safeMessages[code],
		...safeDetails,
		...(part && isSafeErrorPart(part) ? { part } : {}),
		...(sanitizedCauseCode && safeIdentifierPattern.test(sanitizedCauseCode) ? { sanitizedCauseCode } : {}),
	};
}
