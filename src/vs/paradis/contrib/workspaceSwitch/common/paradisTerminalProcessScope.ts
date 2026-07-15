/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { normalize, sep } from '../../../../base/common/path.js';
import { isWindows } from '../../../../base/common/platform.js';

/**
 * ターミナルグループの、グループオブジェクト再作成をまたぐ所属スコープ解決 (機能1 Phase 2 の一部)。
 *
 * `ParadisTerminalWorkspaceScope`（paradisTerminalScope.contribution.ts）が使う。ここに切り出して
 * いるのは、グループ「オブジェクト」の参照ではなく安定な識別子をキーにした純粋なマップ操作だけを、
 * DI/TerminalGroupService に依存せずテストできるようにするため。
 *
 * キーの使い分け:
 * - 今セッション中のライブ記録は `instanceId` をキーにする。moveToBackground →
 *   showBackgroundTerminal によるグループ再作成は同じ ITerminalInstance オブジェクトを
 *   新しいグループへ包み直すだけなので instanceId は安定しており、かつ同期採番のため
 *   「タグ付け時点では未確定」という穴が存在しない（persistentProcessId はプロセス起動後に
 *   非同期で確定するため、生成直後のタグ付けでは記録できないことがある）。
 * - 前回セッションからの復元は `persistentProcessId` をキーにする。instanceId はウィンドウ
 *   セッションごとに振り直されるため、リロードをまたげるのはこちらだけ。
 */
export interface IParadisScopedTerminalInstanceLike {
	readonly instanceId: number;
	readonly persistentProcessId?: number;
}

export interface IParadisTerminalScopeCandidateInput {
	readonly explicitStateKey?: string;
	readonly persistentStateKey?: string;
	readonly initialCwdResolved: boolean;
	readonly worktreeSnapshotReady: boolean;
	readonly initialCwdStateKey?: string;
	readonly activeStateKeyCandidate?: string;
}

export type ParadisTerminalScopeCandidate =
	| { readonly status: 'pending' }
	| { readonly status: 'resolved'; readonly stateKey?: string };

/** 明示指定と永続復元を優先し、それ以外はinitial cwdとworktree一覧が揃うまで確定しない。 */
export function paradisResolveTerminalScopeCandidate(input: IParadisTerminalScopeCandidateInput): ParadisTerminalScopeCandidate {
	const authoritative = input.explicitStateKey ?? input.persistentStateKey;
	if (authoritative !== undefined) {
		return { status: 'resolved', stateKey: authoritative };
	}
	if (!input.initialCwdResolved || !input.worktreeSnapshotReady) {
		return { status: 'pending' };
	}
	const stateKey = input.initialCwdStateKey ?? input.activeStateKeyCandidate;
	return stateKey === undefined ? { status: 'resolved' } : { status: 'resolved', stateKey };
}

const MAX_PERSISTENT_SCOPE_STORAGE_LENGTH = 262_144;
const MAX_PERSISTENT_SCOPE_ENTRIES = 4_096;
const MAX_STATE_KEY_LENGTH = 4_096;

interface ISerializedTerminalProcessScope {
	readonly persistentProcessId: number;
	readonly repositoryId: string;
}

function isValidTerminalProcessScopeEntry(persistentProcessId: unknown, repositoryId: unknown): repositoryId is string {
	return Number.isSafeInteger(persistentProcessId) && (persistentProcessId as number) > 0
		&& typeof repositoryId === 'string' && repositoryId.length > 0 && repositoryId.trim().length > 0
		&& repositoryId.length <= MAX_STATE_KEY_LENGTH && !/[\u0000-\u001f\u007f]/.test(repositoryId);
}

/** 永続snapshotを一時mapへ全件検証し、1件でも不正なら部分採用せず棄却する。 */
export function paradisParseTerminalProcessScopeStorage(raw: string): Map<number, string> | undefined {
	if (raw.length > MAX_PERSISTENT_SCOPE_STORAGE_LENGTH) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_PERSISTENT_SCOPE_ENTRIES) {
		return undefined;
	}
	const candidate = new Map<number, string>();
	for (const value of parsed) {
		if (typeof value !== 'object' || value === null) {
			return undefined;
		}
		const entry = value as Partial<ISerializedTerminalProcessScope>;
		if (!isValidTerminalProcessScopeEntry(entry.persistentProcessId, entry.repositoryId)
			|| candidate.has(entry.persistentProcessId as number)) {
			return undefined;
		}
		candidate.set(entry.persistentProcessId as number, entry.repositoryId);
	}
	return candidate;
}

/** readerと同じ件数・entry・raw文字数上限を満たすsnapshotだけを生成する。 */
export function paradisSerializeTerminalProcessScopeStorage(scopes: ReadonlyMap<number, string>): string | undefined {
	if (scopes.size > MAX_PERSISTENT_SCOPE_ENTRIES) {
		return undefined;
	}
	const entries: ISerializedTerminalProcessScope[] = [];
	for (const [persistentProcessId, repositoryId] of scopes) {
		if (!isValidTerminalProcessScopeEntry(persistentProcessId, repositoryId)) {
			return undefined;
		}
		entries.push({ persistentProcessId, repositoryId });
	}
	const raw = JSON.stringify(entries);
	return raw.length <= MAX_PERSISTENT_SCOPE_STORAGE_LENGTH ? raw : undefined;
}

export interface IParadisPersistentProcessScopePartition {
	readonly accepted: Map<number, string>;
	readonly quarantined: Map<number, string>;
}

/** 既知scopeだけを採用し、worktree初期snapshot前の未知scopeは破棄せず隔離する。 */
export function paradisPartitionPersistentProcessScopesByKnownScope(scopes: ReadonlyMap<number, string>, knownStateKeys: ReadonlySet<string>): IParadisPersistentProcessScopePartition {
	const accepted = new Map<number, string>();
	const quarantined = new Map<number, string>();
	for (const [persistentProcessId, stateKey] of scopes) {
		(knownStateKeys.has(stateKey) ? accepted : quarantined).set(persistentProcessId, stateKey);
	}
	return { accepted, quarantined };
}

/** barrier前の隔離値を保存に残しつつ、同じPIDの今セッション確定値を優先する。 */
export function paradisMergePersistentProcessScopesForStorage(quarantined: ReadonlyMap<number, string>, accepted: ReadonlyMap<number, string>): Map<number, string> {
	return new Map([...quarantined, ...accepted]);
}

/** instanceId ごとの所属スコープ記録に、対象グループの各インスタンスの対応を書き込む */
export function paradisRecordInstanceScopes(instanceScopes: Map<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[], stateKey: string): void {
	for (const instance of instances) {
		instanceScopes.set(instance.instanceId, stateKey);
	}
}

/** processId確定時、ライブinstance台帳の所属を永続process台帳へ反映する。 */
export function paradisRecordPersistentProcessScopes(instanceScopes: ReadonlyMap<number, string>, persistentProcessScopes: Map<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[]): void {
	for (const instance of instances) {
		const stateKey = instanceScopes.get(instance.instanceId);
		if (stateKey !== undefined && typeof instance.persistentProcessId === 'number') {
			persistentProcessScopes.set(instance.persistentProcessId, stateKey);
		}
	}
}

/** 再接続されたinstanceへ、前回セッションのpersistent process台帳から所属を復元する。 */
export function paradisRestorePersistentProcessScope(instanceScopes: Map<number, string>, persistentProcessScopes: ReadonlyMap<number, string>, instance: IParadisScopedTerminalInstanceLike): string | undefined {
	const recordedStateKey = instanceScopes.get(instance.instanceId);
	if (recordedStateKey !== undefined || typeof instance.persistentProcessId !== 'number') {
		return recordedStateKey;
	}
	const restoredStateKey = persistentProcessScopes.get(instance.persistentProcessId);
	if (restoredStateKey !== undefined) {
		instanceScopes.set(instance.instanceId, restoredStateKey);
	}
	return restoredStateKey;
}

/** 再接続完了後、どのlive terminalにも対応しない前回セッションのprocess台帳を削除する。 */
export function paradisPrunePersistentProcessScopes(persistentProcessScopes: Map<number, string>, liveInstances: readonly IParadisScopedTerminalInstanceLike[]): void {
	const livePersistentProcessIds = new Set<number>();
	for (const instance of liveInstances) {
		if (typeof instance.persistentProcessId === 'number') {
			livePersistentProcessIds.add(instance.persistentProcessId);
		}
	}
	for (const persistentProcessId of persistentProcessScopes.keys()) {
		if (!livePersistentProcessIds.has(persistentProcessId)) {
			persistentProcessScopes.delete(persistentProcessId);
		}
	}
}

/**
 * グループの所属スコープを、構成インスタンスから引く。
 * 今セッション中の記録 (`instanceScopes`、instanceId キー) を優先し、無ければ前回セッションからの
 * 保存済みマッピング (`restoredMapping`、persistentProcessId キー) にフォールバックする。
 * どちらにも無ければ (真に新規のグループなら) undefined を返す。
 */
export function paradisLookupInstanceScope(instanceScopes: ReadonlyMap<number, string>, restoredMapping: ReadonlyMap<number, string>, instances: readonly IParadisScopedTerminalInstanceLike[]): string | undefined {
	for (const instance of instances) {
		const live = instanceScopes.get(instance.instanceId);
		if (live) {
			return live;
		}
	}
	for (const instance of instances) {
		if (typeof instance.persistentProcessId === 'number') {
			const restored = restoredMapping.get(instance.persistentProcessId);
			if (restored) {
				return restored;
			}
		}
	}
	return undefined;
}

/** initial cwdとの照合に使う登録済みrepository/worktree root。 */
export interface IParadisTerminalScopeRoot {
	readonly root: string;
	readonly stateKey: string;
}

/** 生成時cwdを登録済みrepository/worktreeルートへ境界付き最長一致させる。 */
export function paradisResolveInitialCwdScope(initialCwd: string | undefined, roots: readonly IParadisTerminalScopeRoot[]): string | undefined {
	if (initialCwd === undefined || initialCwd.length === 0) {
		return undefined;
	}
	const cwd = normalize(initialCwd);
	const comparableCwd = isWindows ? cwd.toLowerCase() : cwd;
	let best: { readonly rootLength: number; readonly stateKey: string } | undefined;
	for (const candidate of roots) {
		if (candidate.root.length === 0) {
			continue;
		}
		const root = normalize(candidate.root);
		const comparableRoot = isWindows ? root.toLowerCase() : root;
		const isWithinRoot = comparableCwd === comparableRoot || comparableCwd.startsWith(comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep);
		if (isWithinRoot && (best === undefined || root.length > best.rootLength)) {
			best = { rootLength: root.length, stateKey: candidate.stateKey };
		}
	}
	return best?.stateKey;
}

/** 実terminal破棄時は対応するprocessも削除する。renderer shutdown時だけ再接続用process台帳を保持する。 */
export function paradisRetireInstanceScope(instanceScopes: Map<number, string>, persistentProcessScopes: Map<number, string>, instance: IParadisScopedTerminalInstanceLike, persistentProcessOwners?: ReadonlyMap<number, number>, preservePersistentProcess = false): void {
	const stateKey = instanceScopes.get(instance.instanceId)
		?? (typeof instance.persistentProcessId === 'number' ? persistentProcessScopes.get(instance.persistentProcessId) : undefined);
	instanceScopes.delete(instance.instanceId);
	if (!preservePersistentProcess
		&& stateKey !== undefined
		&& typeof instance.persistentProcessId === 'number'
		&& (persistentProcessOwners === undefined || persistentProcessOwners.get(instance.persistentProcessId) === instance.instanceId)
		&& persistentProcessScopes.get(instance.persistentProcessId) === stateKey) {
		persistentProcessScopes.delete(instance.persistentProcessId);
	}
}

/** repository/worktree退役時は、そのscopeに属する両台帳の対応を一括削除する。 */
export function paradisRetireTerminalScope(instanceScopes: Map<number, string>, persistentProcessScopes: Map<number, string>, stateKey: string): void {
	for (const [instanceId, assignedStateKey] of instanceScopes) {
		if (assignedStateKey === stateKey) {
			instanceScopes.delete(instanceId);
		}
	}
	for (const [persistentProcessId, assignedStateKey] of persistentProcessScopes) {
		if (assignedStateKey === stateKey) {
			persistentProcessScopes.delete(persistentProcessId);
		}
	}
}

/** 台帳を消す前に、visible/background/parkedを問わず退役scope所有のlive instanceを列挙する。 */
export function paradisCollectRetiringTerminalInstanceIds(instanceScopes: ReadonlyMap<number, string>, persistentProcessScopes: ReadonlyMap<number, string>, stateKey: string, liveInstances: readonly IParadisScopedTerminalInstanceLike[]): number[] {
	const result: number[] = [];
	for (const instance of liveInstances) {
		const assignedStateKey = instanceScopes.get(instance.instanceId)
			?? (typeof instance.persistentProcessId === 'number' ? persistentProcessScopes.get(instance.persistentProcessId) : undefined);
		if (assignedStateKey === stateKey) {
			result.push(instance.instanceId);
		}
	}
	return result;
}
