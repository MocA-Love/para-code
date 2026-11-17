/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Office の web worker を使う側（主スレッド）の型・接続口・クライアント。worker の入口と解析本体は
// paradisOfficeWebWorker.ts にある。エディタはこのファイルだけを静的に読み、解析本体は worker が読む。

import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import {
	PARADIS_OFFICE_ALL_FEATURES,
	getParadisOfficeRuntimeFeatureBits,
	negotiateParadisOfficeCapabilities,
	type ParadisOfficeCapabilitySet,
	type ParadisOfficeRuntimeConfiguration,
} from '../common/paradisOfficeCapabilities.js';
import {
	PARADIS_OFFICE_BUDGET_PROFILES,
	isOfficeSerializableData,
	type ParadisOfficeChangeCategory,
	type ParadisOfficeFormat,
} from '../common/paradisOfficeProtocol.js';
import type { ParadisSemanticCell, ParadisSpreadsheetColor } from '../common/spreadsheet/paradisSpreadsheetSemantic.js';
import type { ParadisWordDrawingGeometry, ParadisWordTableDiagonalBorder } from '../common/word/paradisWordSemantic.js';
import type { ParadisOfficeSemanticFormat } from './paradisFileViewers.js';

const webWorkerCancelGraceMilliseconds = 250;

export interface ParadisOfficeBrowserSpreadsheetDiagonal {
	readonly up: boolean;
	readonly down: boolean;
	readonly style?: string;
	readonly color?: ParadisSpreadsheetColor;
}

export interface ParadisOfficeBrowserSpreadsheetCell {
	readonly address: string;
	readonly row: number;
	readonly column: number;
	readonly text: string;
	readonly storedType: ParadisSemanticCell['storedType'];
	readonly diagonal?: ParadisOfficeBrowserSpreadsheetDiagonal;
}

export interface ParadisOfficeBrowserSpreadsheetSummary {
	readonly kind: 'spreadsheet';
	readonly format: Extract<ParadisOfficeFormat, 'xlsx' | 'xlsm' | 'xltx' | 'xltm'>;
	readonly budgetProfile: 'browser';
	readonly sheets: readonly {
		readonly name: string;
		readonly cells: readonly ParadisOfficeBrowserSpreadsheetCell[];
		readonly truncated: boolean;
	}[];
	readonly externalRelationshipCount: number;
}

export interface ParadisOfficeBrowserWordSummary {
	readonly kind: 'word';
	readonly format: Extract<ParadisOfficeFormat, 'docx' | 'docm' | 'dotx' | 'dotm'>;
	readonly budgetProfile: 'browser';
	readonly stories: readonly { readonly kind: string; readonly text: string; readonly truncated: boolean }[];
	readonly truncated: boolean;
	readonly drawings: readonly { readonly nodeId: string; readonly geometry: ParadisWordDrawingGeometry }[];
	readonly tableDiagonals: readonly ParadisWordTableDiagonalBorder[];
	readonly externalRelationshipCount: number;
}

export interface ParadisOfficeBrowserDiffSummary {
	readonly kind: 'diff';
	readonly format: ParadisOfficeSemanticFormat;
	readonly budgetProfile: 'browser';
	readonly changes: readonly {
		readonly id: string;
		readonly category: ParadisOfficeChangeCategory;
		readonly subjectKind: string;
		readonly locator: string;
		readonly certainty: string;
	}[];
	readonly terminal: boolean;
}

export type ParadisOfficeBrowserSemanticSummary = ParadisOfficeBrowserSpreadsheetSummary | ParadisOfficeBrowserWordSummary | ParadisOfficeBrowserDiffSummary;

export type ParadisOfficeWebWorkerRunMessage = {
	readonly kind: 'run';
	readonly requestId: string;
	readonly operation: 'view' | 'diff';
	readonly format: ParadisOfficeSemanticFormat;
	readonly originalBytes: Uint8Array | ArrayBuffer;
	readonly modifiedBytes?: Uint8Array | ArrayBuffer;
};

export type ParadisOfficeWebWorkerMessage =
	| ParadisOfficeWebWorkerRunMessage
	| { readonly kind: 'cancel'; readonly requestId: string }
	| { readonly kind: 'result'; readonly requestId: string; readonly value: ParadisOfficeBrowserSemanticSummary }
	| { readonly kind: 'cancelled'; readonly requestId: string }
	| { readonly kind: 'failure'; readonly requestId: string; readonly reason: 'unsupported' | 'limitExceeded' | 'workerFailed' };

export type ParadisOfficeWebWorkerOutcome =
	| { readonly kind: 'result'; readonly value: ParadisOfficeBrowserSemanticSummary }
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'blocked'; readonly reason: 'workerUnavailable' | 'deadline' | 'unsupported' | 'limitExceeded' }
	| { readonly kind: 'failed'; readonly reason: 'workerFailed' };

export interface IParadisOfficeWebWorkerEndpoint {
	postMessage(message: ParadisOfficeWebWorkerMessage, transfer: readonly ArrayBuffer[]): void;
	addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
	removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
	terminate(): void;
}

export type ParadisOfficeNativeWorkerFactory = (url: string, options: WorkerOptions) => IParadisOfficeWebWorkerEndpoint;

export function createParadisOfficeWebWorkerEndpoint(
	scriptUrl: string,
	pageOrigin: string,
	createWorker: ParadisOfficeNativeWorkerFactory,
): IParadisOfficeWebWorkerEndpoint {
	let page: URL;
	let script: URL;
	try {
		page = new URL(pageOrigin);
		script = new URL(scriptUrl, page);
	} catch {
		throw new Error('Paradis Office Web Worker is unavailable.');
	}
	if ((page.protocol !== 'http:' && page.protocol !== 'https:')
		|| (script.protocol !== 'http:' && script.protocol !== 'https:')
		|| script.origin !== page.origin
		|| script.username.length > 0
		|| script.password.length > 0) {
		throw new Error('Paradis Office Web Worker is unavailable.');
	}
	return createWorker(script.toString(), { name: 'ParadisOfficeWebWorker', type: 'module' });
}

export function getParadisOfficeWebWorkerCapabilities(
	available: boolean,
	runtimeConfiguration?: ParadisOfficeRuntimeConfiguration,
): ParadisOfficeCapabilitySet {
	const featureBits = runtimeConfiguration ? getParadisOfficeRuntimeFeatureBits(runtimeConfiguration) : PARADIS_OFFICE_ALL_FEATURES;
	return negotiateParadisOfficeCapabilities({
		client: { version: 1, platform: 'web', featureBits },
		backend: { version: 1, kind: 'webWorker', available, featureBits: available ? PARADIS_OFFICE_ALL_FEATURES : 0 },
	});
}

interface ParadisOfficeWebWorkerClientOptions<TTimer> {
	readonly createWorker: () => IParadisOfficeWebWorkerEndpoint;
	readonly setTimeout?: (runner: () => void, delay: number) => TTimer;
	readonly clearTimeout?: (timer: TTimer) => void;
}

export class ParadisOfficeWebWorkerClient<TTimer = number> {
	private requestId = 0;
	private readonly setTimer: (runner: () => void, delay: number) => TTimer;
	private readonly clearTimer: (timer: TTimer) => void;

	constructor(private readonly options: ParadisOfficeWebWorkerClientOptions<TTimer>) {
		this.setTimer = options.setTimeout ?? ((runner, delay) => globalThis.setTimeout(runner, delay) as TTimer);
		this.clearTimer = options.clearTimeout ?? (timer => globalThis.clearTimeout(timer as number));
	}

	run(
		operation: 'view' | 'diff',
		format: ParadisOfficeSemanticFormat,
		originalBytes: Uint8Array,
		modifiedBytes: Uint8Array | undefined,
		token: CancellationToken,
	): Promise<ParadisOfficeWebWorkerOutcome> {
		if (token.isCancellationRequested) {
			return Promise.resolve({ kind: 'cancelled' });
		}
		let worker: IParadisOfficeWebWorkerEndpoint;
		try {
			worker = this.options.createWorker();
		} catch {
			return Promise.resolve({ kind: 'blocked', reason: 'workerUnavailable' });
		}
		const requestId = String(++this.requestId);
		const original = copyBytesForTransfer(originalBytes);
		const modified = modifiedBytes ? copyBytesForTransfer(modifiedBytes) : undefined;
		const deadlineMilliseconds = operation === 'diff'
			? PARADIS_OFFICE_BUDGET_PROFILES.browser.diffMilliseconds
			: PARADIS_OFFICE_BUDGET_PROFILES.browser.semanticParseMilliseconds;

		return new Promise<ParadisOfficeWebWorkerOutcome>(resolve => {
			let settled = false;
			let terminal: 'cancelled' | 'deadline' | undefined;
			const cancellationListener: { value?: IDisposable } = {};
			const deadlineTimer: { value?: TTimer } = {};
			let reapTimer: TTimer | undefined;

			const cleanup = () => {
				cancellationListener.value?.dispose();
				if (deadlineTimer.value !== undefined) {
					this.clearTimer(deadlineTimer.value);
				}
				if (reapTimer !== undefined) {
					this.clearTimer(reapTimer);
				}
				worker.removeEventListener('message', onMessage as EventListener);
				worker.removeEventListener('error', onError);
				worker.removeEventListener('messageerror', onError);
				worker.terminate();
			};
			const finish = (outcome: ParadisOfficeWebWorkerOutcome) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(outcome);
			};
			const requestCancellation = (reason: 'cancelled' | 'deadline') => {
				if (settled || terminal) {
					return;
				}
				terminal = reason;
				try {
					worker.postMessage({ kind: 'cancel', requestId }, []);
				} catch {
					finish(reason === 'cancelled' ? { kind: 'cancelled' } : { kind: 'blocked', reason: 'deadline' });
					return;
				}
				reapTimer = this.setTimer(() => finish(reason === 'cancelled' ? { kind: 'cancelled' } : { kind: 'blocked', reason: 'deadline' }), webWorkerCancelGraceMilliseconds);
			};
			const onMessage = (event: MessageEvent<ParadisOfficeWebWorkerMessage>) => {
				const rawMessage: unknown = event.data;
				if (!isOfficeSerializableData(rawMessage)) {
					finish({ kind: 'blocked', reason: 'limitExceeded' });
					return;
				}
				const message = rawMessage as ParadisOfficeWebWorkerMessage;
				if (!message || message.requestId !== requestId || (message.kind !== 'result' && message.kind !== 'cancelled' && message.kind !== 'failure')) {
					return;
				}
				if (terminal === 'cancelled' || message.kind === 'cancelled') {
					finish({ kind: 'cancelled' });
					return;
				}
				if (terminal === 'deadline') {
					finish({ kind: 'blocked', reason: 'deadline' });
					return;
				}
				if (message.kind === 'result') {
					finish({ kind: 'result', value: message.value });
				} else if (message.reason === 'workerFailed') {
					finish({ kind: 'failed', reason: 'workerFailed' });
				} else {
					finish({ kind: 'blocked', reason: message.reason });
				}
			};
			const onError = () => finish(terminal === 'cancelled'
				? { kind: 'cancelled' }
				: terminal === 'deadline'
					? { kind: 'blocked', reason: 'deadline' }
					: { kind: 'failed', reason: 'workerFailed' });

			worker.addEventListener('message', onMessage as EventListener);
			worker.addEventListener('error', onError);
			worker.addEventListener('messageerror', onError);
			cancellationListener.value = token.onCancellationRequested(() => requestCancellation('cancelled'));
			if (terminal) {
				return;
			}
			deadlineTimer.value = this.setTimer(() => requestCancellation('deadline'), deadlineMilliseconds);
			try {
				const message: ParadisOfficeWebWorkerRunMessage = {
					kind: 'run', requestId, operation, format, originalBytes: original,
					...(modified ? { modifiedBytes: modified } : {}),
				};
				worker.postMessage(message, modified ? [original, modified] : [original]);
			} catch {
				finish({ kind: 'failed', reason: 'workerFailed' });
			}
		});
	}
}

function copyBytesForTransfer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}
