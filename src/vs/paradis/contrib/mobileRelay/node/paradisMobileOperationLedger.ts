/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { ParadisMobileTerminalOperationStatus } from '../common/paradisMobileRelay.js';
import { IParadisMobileWindowLease } from '../common/paradisMobileWindowLease.js';

export type IParadisMobileWindowLeaseRef = IParadisMobileWindowLease;

interface IPendingOperation {
	readonly mobileId: string;
	readonly operationId: string;
	readonly operationRun: number;
	readonly operationSeq: number;
	owner: IParadisMobileWindowLeaseRef | undefined;
	state: 'pending' | 'unknown';
}

type OperationBeginResult =
	| { readonly kind: 'started' }
	| { readonly kind: 'pending' }
	| { readonly kind: 'unknown' }
	| { readonly kind: 'final'; readonly status: ParadisMobileTerminalOperationStatus };

/**
 * operationRun/Seqの高水位を詳細結果キャッシュと分離する。結果を退避しても低い連番は
 * `unknown`としてfail closedになり、同じ操作を再実行しない。
 */
export class ParadisMobileOperationLedger {
	private readonly pending = new Map<string, IPendingOperation>();
	private readonly final = new Map<string, ParadisMobileTerminalOperationStatus>();
	// operationRunはmobile process全体の世代なので全windowで共有する。一方seqは、
	// Rendererが独立して復旧するv3では別window向けの保留操作を飛び越えうるため、
	// 同一run内だけ配送先window単位で追跡する。
	private readonly highestRunByMobile = new Map<string, number>();
	private readonly highestSeenSeqByTargetRun = new Map<string, number>();

	constructor(
		private readonly maxFinalEntries = 1000,
		private readonly maxPendingPerMobile = 256,
	) { }

	lookup(mobileId: string, operationId: string): Exclude<OperationBeginResult, { readonly kind: 'started' }> | undefined {
		const key = this.key(mobileId, operationId);
		const status = this.final.get(key);
		if (status !== undefined) {
			return { kind: 'final', status };
		}
		const pending = this.pending.get(key);
		return pending === undefined ? undefined : { kind: pending.state };
	}

	begin(mobileId: string, operationId: string, operationRun: number, operationSeq: number, owner?: IParadisMobileWindowLeaseRef): OperationBeginResult {
		const existing = this.lookup(mobileId, operationId);
		if (existing !== undefined) {
			return existing;
		}

		const highestRun = this.highestRunByMobile.get(mobileId);
		if (highestRun !== undefined && operationRun < highestRun) {
			return { kind: 'unknown' };
		}
		if (highestRun === undefined || operationRun > highestRun) {
			this.highestRunByMobile.set(mobileId, operationRun);
			const targetPrefix = `${mobileId}\0`;
			for (const key of this.highestSeenSeqByTargetRun.keys()) {
				if (key.startsWith(targetPrefix)) {
					this.highestSeenSeqByTargetRun.delete(key);
				}
			}
		}

		const highWaterKey = this.highWaterKey(mobileId, operationRun, owner);
		const highestSeenSeq = this.highestSeenSeqByTargetRun.get(highWaterKey);
		if (highestSeenSeq !== undefined && operationSeq <= highestSeenSeq) {
			return { kind: 'unknown' };
		}
		this.highestSeenSeqByTargetRun.set(highWaterKey, operationSeq);

		let mobilePending = 0;
		for (const pending of this.pending.values()) {
			if (pending.mobileId === mobileId) {
				mobilePending++;
			}
		}
		if (mobilePending >= this.maxPendingPerMobile) {
			for (const [key, pending] of this.pending) {
				if (pending.mobileId === mobileId && pending.state === 'unknown') {
					this.pending.delete(key);
					mobilePending--;
					if (mobilePending < this.maxPendingPerMobile) {
						break;
					}
				}
			}
		}
		if (mobilePending >= this.maxPendingPerMobile) {
			return { kind: 'unknown' };
		}

		this.pending.set(this.key(mobileId, operationId), {
			mobileId, operationId, operationRun, operationSeq, owner, state: 'pending',
		});
		return { kind: 'started' };
	}

	bindOwner(mobileId: string, operationId: string, owner: IParadisMobileWindowLeaseRef): boolean {
		const pending = this.pending.get(this.key(mobileId, operationId));
		if (pending === undefined || (pending.owner !== undefined && !this.sameLease(pending.owner, owner))) {
			return false;
		}
		pending.owner = owner;
		return true;
	}

	complete(mobileId: string, operationId: string, owner: IParadisMobileWindowLeaseRef, status: ParadisMobileTerminalOperationStatus): boolean {
		const key = this.key(mobileId, operationId);
		const pending = this.pending.get(key);
		if (pending?.owner === undefined || !this.sameLease(pending.owner, owner)) {
			return false;
		}
		this.pending.delete(key);
		this.storeFinal(key, status);
		return true;
	}

	finalize(mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus): boolean {
		const key = this.key(mobileId, operationId);
		if (!this.pending.delete(key)) {
			return false;
		}
		this.storeFinal(key, status);
		return true;
	}

	markOutcomeUnknown(mobileId: string, operationId: string, owner: IParadisMobileWindowLeaseRef): boolean {
		const pending = this.pending.get(this.key(mobileId, operationId));
		if (pending?.owner === undefined || !this.sameLease(pending.owner, owner)) {
			return false;
		}
		pending.state = 'unknown';
		return true;
	}

	markOwnerOutcomeUnknown(owner: IParadisMobileWindowLeaseRef): readonly { mobileId: string; operationId: string }[] {
		const changed: { mobileId: string; operationId: string }[] = [];
		for (const pending of this.pending.values()) {
			if (pending.owner !== undefined && this.sameLease(pending.owner, owner) && pending.state !== 'unknown') {
				pending.state = 'unknown';
				changed.push({ mobileId: pending.mobileId, operationId: pending.operationId });
			}
		}
		return changed;
	}

	private storeFinal(key: string, status: ParadisMobileTerminalOperationStatus): void {
		this.final.set(key, status);
		while (this.final.size > this.maxFinalEntries) {
			const oldest = this.final.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.final.delete(oldest);
		}
	}

	private sameLease(a: IParadisMobileWindowLeaseRef, b: IParadisMobileWindowLeaseRef): boolean {
		return a.windowId === b.windowId && a.windowSession === b.windowSession && a.rendererGeneration === b.rendererGeneration;
	}

	private key(mobileId: string, operationId: string): string {
		return `${mobileId}\0${operationId}`;
	}

	private highWaterKey(mobileId: string, operationRun: number, owner: IParadisMobileWindowLeaseRef | undefined): string {
		// owner未指定は防御的な従来互換。Relay本体はowner解決後にbeginする。
		return `${mobileId}\0${operationRun}\0${owner?.windowId ?? 'unscoped'}`;
	}
}
