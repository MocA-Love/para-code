/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { ParadisMobileTerminalOperationStatus } from '../common/paradisMobileRelay.js';

export interface IParadisMobileWindowLeaseRef {
	readonly windowId: number;
	readonly windowSession: string;
}

interface IPendingOperation extends IParadisMobileWindowLeaseRef {
	readonly mobileId: string;
	readonly operationId: string;
}

type OperationBeginResult =
	| { readonly kind: 'started' }
	| { readonly kind: 'pending' }
	| { readonly kind: 'final'; readonly status: ParadisMobileTerminalOperationStatus };

/** operationIdの実行中/完了を分離し、同じ操作の二重実行と早すぎる成功確定を防ぐ。 */
export class ParadisMobileOperationLedger {
	private readonly pending = new Map<string, IPendingOperation>();
	private readonly final = new Map<string, ParadisMobileTerminalOperationStatus>();

	constructor(private readonly maxFinalEntries = 1000) { }

	lookup(mobileId: string, operationId: string): Exclude<OperationBeginResult, { readonly kind: 'started' }> | undefined {
		const key = this.key(mobileId, operationId);
		const status = this.final.get(key);
		if (status !== undefined) {
			return { kind: 'final', status };
		}
		return this.pending.has(key) ? { kind: 'pending' } : undefined;
	}

	begin(mobileId: string, operationId: string, owner: IParadisMobileWindowLeaseRef): OperationBeginResult {
		const existing = this.lookup(mobileId, operationId);
		if (existing !== undefined) {
			return existing;
		}
		const key = this.key(mobileId, operationId);
		this.pending.set(key, { ...owner, mobileId, operationId });
		return { kind: 'started' };
	}

	complete(mobileId: string, operationId: string, owner: IParadisMobileWindowLeaseRef, status: ParadisMobileTerminalOperationStatus): boolean {
		const key = this.key(mobileId, operationId);
		const pending = this.pending.get(key);
		if (pending?.windowId !== owner.windowId || pending.windowSession !== owner.windowSession) {
			return false;
		}
		this.pending.delete(key);
		this.storeFinal(key, status);
		return true;
	}

	finalize(mobileId: string, operationId: string, status: ParadisMobileTerminalOperationStatus): void {
		const key = this.key(mobileId, operationId);
		this.pending.delete(key);
		this.storeFinal(key, status);
	}

	finalizeOwner(owner: IParadisMobileWindowLeaseRef, status: ParadisMobileTerminalOperationStatus): readonly { mobileId: string; operationId: string; status: ParadisMobileTerminalOperationStatus }[] {
		const completed: { mobileId: string; operationId: string; status: ParadisMobileTerminalOperationStatus }[] = [];
		for (const [key, pending] of this.pending) {
			if (pending.windowId !== owner.windowId || pending.windowSession !== owner.windowSession) {
				continue;
			}
			this.pending.delete(key);
			this.storeFinal(key, status);
			completed.push({ mobileId: pending.mobileId, operationId: pending.operationId, status });
		}
		return completed;
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

	private key(mobileId: string, operationId: string): string {
		return `${mobileId}\0${operationId}`;
	}
}
