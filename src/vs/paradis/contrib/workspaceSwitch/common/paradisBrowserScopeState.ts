/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IParadisBrowserStableScopeChangeEvent, ParadisBindingScope, ParadisBrowserStableScopeChangeReason, ParadisStableBindingScope, paradisBindingScopesEqual } from './paradisWorkspaceSwitch.js';

export const PARADIS_BROWSER_SCOPE_STORAGE_KEY = 'paradis.workspaceSwitch.browserScopes.v1';

export type ParadisBrowserScopeStorageParseResult =
	| { readonly kind: 'absent' }
	| { readonly kind: 'corrupt' }
	| { readonly kind: 'valid'; readonly entries: readonly (readonly [string, string])[] };

interface ISerializedBrowserScopeStorage {
	readonly version: 1;
	readonly entries: readonly { readonly viewId: string; readonly stateKey: string }[];
}

export function paradisParseBrowserScopeStorage(raw: string | undefined): ParadisBrowserScopeStorageParseResult {
	if (raw === undefined) {
		return { kind: 'absent' };
	}
	try {
		const value = JSON.parse(raw) as Partial<ISerializedBrowserScopeStorage>;
		if (value?.version !== 1 || !Array.isArray(value.entries)) {
			return { kind: 'corrupt' };
		}
		const seen = new Set<string>();
		const entries: [string, string][] = [];
		for (const entry of value.entries) {
			if (!entry || typeof entry.viewId !== 'string' || entry.viewId.length === 0
				|| typeof entry.stateKey !== 'string' || entry.stateKey.length === 0
				|| seen.has(entry.viewId)) {
				return { kind: 'corrupt' };
			}
			seen.add(entry.viewId);
			entries.push([entry.viewId, entry.stateKey]);
		}
		return { kind: 'valid', entries };
	} catch {
		return { kind: 'corrupt' };
	}
}

/**
 * BrowserView scopeのpure state machine。永続化対象Mapはこのクラスだけが保持し、
 * workbench service側に同じ台帳を複製しない。
 */
export class ParadisBrowserScopeState extends Disposable {
	private readonly _viewRepositories = new Map<string, string>();
	/** Stable non-managed state only. Managed authority lives exclusively in _viewRepositories. */
	private readonly _unscoped = new Set<string>();
	private readonly _pending = new Set<string>();
	private readonly _retiredBeforeInitialization = new Set<string>();
	private readonly _onDidChangeStableScope = this._register(new Emitter<IParadisBrowserStableScopeChangeEvent>());
	readonly onDidChangeStableScope: Event<IParadisBrowserStableScopeChangeEvent> = this._onDidChangeStableScope.event;
	readonly storageStatus: ParadisBrowserScopeStorageParseResult['kind'];
	private _revision = 0;
	private _initialized = false;

	constructor(raw: string | undefined) {
		super();
		const parsed = paradisParseBrowserScopeStorage(raw);
		this.storageStatus = parsed.kind;
		if (parsed.kind === 'valid') {
			for (const [viewId, stateKey] of parsed.entries) {
				this._viewRepositories.set(viewId, stateKey);
			}
		}
	}

	get revision(): number { return this._revision; }
	get initialized(): boolean { return this._initialized; }

	resolveScope(viewId: string): ParadisBindingScope {
		const stateKey = this._viewRepositories.get(viewId);
		if (stateKey !== undefined) {
			return { kind: 'managed', stateKey };
		}
		if (this._pending.has(viewId) || !this._initialized) {
			return { kind: 'pending' };
		}
		return this._unscoped.has(viewId) ? { kind: 'unscoped' } : { kind: 'pending' };
	}

	markPending(viewId: string): void {
		if (!this._viewRepositories.has(viewId) && !this._unscoped.has(viewId)) {
			this._pending.add(viewId);
		}
	}

	tagManaged(viewId: string, stateKey: string, reason: Exclude<ParadisBrowserStableScopeChangeReason, 'scopeRetire'>): void {
		const previousScope = this._getStableScope(viewId);
		this._pending.delete(viewId);
		this._unscoped.delete(viewId);
		this._viewRepositories.set(viewId, stateKey);
		this._emitStableScope(viewId, previousScope, { kind: 'managed', stateKey }, reason);
	}

	tagUnscoped(viewId: string, reason: Exclude<ParadisBrowserStableScopeChangeReason, 'scopeRetire'> = 'initialTag'): void {
		const previousScope = this._getStableScope(viewId);
		this._pending.delete(viewId);
		this._viewRepositories.delete(viewId);
		this._unscoped.add(viewId);
		this._emitStableScope(viewId, previousScope, { kind: 'unscoped' }, reason);
	}

	deleteForUserClose(viewId: string): boolean {
		this._pending.delete(viewId);
		this._unscoped.delete(viewId);
		return this._viewRepositories.delete(viewId);
	}

	retireScope(stateKey: string): readonly string[] {
		const retired: string[] = [];
		for (const [viewId, assignedStateKey] of [...this._viewRepositories]) {
			if (assignedStateKey !== stateKey) {
				continue;
			}
			retired.push(viewId);
			this._viewRepositories.delete(viewId);
			this._pending.delete(viewId);
			const previousScope: ParadisStableBindingScope = { kind: 'managed', stateKey: assignedStateKey };
			this._unscoped.delete(viewId);
			if (!this._initialized) {
				this._retiredBeforeInitialization.add(viewId);
			}
			this._onDidChangeStableScope.fire({
				viewId,
				previousScope,
				scope: undefined,
				revision: ++this._revision,
				reason: 'scopeRetire',
			});
		}
		return retired;
	}

	isRetiredBeforeInitialization(viewId: string): boolean {
		return this._retiredBeforeInitialization.has(viewId);
	}

	convergeRetiredView(viewId: string): void {
		this._retiredBeforeInitialization.delete(viewId);
	}

	completeInitialization(snapshotSucceeded: boolean, snapshotLiveViewIds: ReadonlySet<string> = new Set()): void {
		this._initialized = true;
		if (snapshotSucceeded) {
			for (const viewId of [...this._retiredBeforeInitialization]) {
				if (!snapshotLiveViewIds.has(viewId)) {
					this._retiredBeforeInitialization.delete(viewId);
				}
			}
		}
	}

	serialize(): string {
		const entries = [...this._viewRepositories]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([viewId, stateKey]) => ({ viewId, stateKey }));
		return JSON.stringify({ version: 1, entries } satisfies ISerializedBrowserScopeStorage);
	}

	private _getStableScope(viewId: string): ParadisStableBindingScope | undefined {
		const stateKey = this._viewRepositories.get(viewId);
		return stateKey !== undefined ? { kind: 'managed', stateKey } : this._unscoped.has(viewId) ? { kind: 'unscoped' } : undefined;
	}

	private _emitStableScope(viewId: string, previousScope: ParadisStableBindingScope | undefined, scope: ParadisStableBindingScope, reason: Exclude<ParadisBrowserStableScopeChangeReason, 'scopeRetire'>): void {
		if (paradisBindingScopesEqual(previousScope, scope)) {
			return;
		}
		this._onDidChangeStableScope.fire({ viewId, previousScope, scope, revision: ++this._revision, reason });
	}
}
