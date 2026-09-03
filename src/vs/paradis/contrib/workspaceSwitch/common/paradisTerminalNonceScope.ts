/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// ターミナルの所属スペースを、shell integration nonce をキーにして覚えておく台帳。
//
// 既存の台帳（paradisTerminalProcessScope.ts）は PTY の ID をキーにしていて、そこに2つの穴がある:
// ID はプロセスが起動してから非同期に決まるので、タグ付け直後にリロードすると書き出せずに漏れる。
// そして revive をまたぐと ID 自体が振り直され、旧 ID との対応は revive を経た PTY でしか引けない。
// 漏れた端末は所属不明になり、「今アクティブなスペース」へ推測で寄せられて混ざる。
//
// nonce は端末の構築時に同期で決まり（terminalProcessManager が持たなければ採番する）、revive の
// ときも旧 launch config ごと引き継がれるので値が変わらない。上の2つの穴が原理的に無い。
//
// この台帳は既存の ID 台帳を置き換えず、先に引く索引として足す。引けなければ従来どおりの経路へ
// 落ちるだけなので、既存の解決結果は変わらない。

import { paradisTerminalIdentityNonce } from '../../../../platform/terminal/common/terminal.js';
import { paradisPreviousSessionPtyId } from './paradisTerminalProcessScope.js';

/**
 * nonce の長さ上限。`paradisTerminalIdentityNonce`（platform 側）が通す上限と同じ値にしてある。
 * ここだけ緩いと、ストレージ経由でのみ生き残る「実行時には絶対に一致しない」記録を受け入れて
 * しまう。platform 側の定数は非公開なので値で揃える。
 */
const MAX_NONCE_LENGTH = 200;
const MAX_STATE_KEY_LENGTH = 4_096;
const MAX_STORAGE_LENGTH = 262_144;
const MAX_ENTRIES = 4_096;

interface ISerializedTerminalNonceScope {
	readonly nonce: string;
	readonly repositoryId: string;
}

/** 台帳のキーに使える nonce だけを通す。空（切り離された端末）や制御文字混じりは弾く。 */
function isValidNonce(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim().length > 0
		&& value.length <= MAX_NONCE_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

function isValidStateKey(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.trim().length > 0
		&& value.length <= MAX_STATE_KEY_LENGTH && !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * 保存済み台帳を読み戻す。1件でも壊れていれば部分採用せず全体を捨てる
 * （ID 台帳と同じ方針。半端に生き残った対応で誤ったスペースへ寄せる方が害が大きい）。
 */
export function paradisParseTerminalNonceScopeStorage(raw: string): Map<string, string> | undefined {
	if (raw.length > MAX_STORAGE_LENGTH) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length > MAX_ENTRIES) {
		return undefined;
	}
	const result = new Map<string, string>();
	for (const value of parsed) {
		if (value === null || typeof value !== 'object') {
			return undefined;
		}
		const { nonce, repositoryId } = value as Partial<ISerializedTerminalNonceScope>;
		if (!isValidNonce(nonce) || !isValidStateKey(repositoryId) || result.has(nonce)) {
			return undefined;
		}
		result.set(nonce, repositoryId);
	}
	return result;
}

/** 台帳を保存用の文字列にする。上限を超えるなら保存を諦める（既存を残す）。 */
export function paradisSerializeTerminalNonceScopeStorage(scopes: ReadonlyMap<string, string>): string | undefined {
	const entries: ISerializedTerminalNonceScope[] = [];
	for (const [nonce, repositoryId] of scopes) {
		if (isValidNonce(nonce) && isValidStateKey(repositoryId)) {
			entries.push({ nonce, repositoryId });
		}
	}
	if (entries.length > MAX_ENTRIES) {
		return undefined;
	}
	const raw = JSON.stringify(entries);
	return raw.length > MAX_STORAGE_LENGTH ? undefined : raw;
}

/**
 * 旧 ID 台帳を nonce 台帳へ翻訳する。
 *
 * 移行の初回起動では nonce 台帳が空なので、翻訳を挟まないと全端末がいきなり所属不明になる。
 * PTY の一覧は ID と nonce の両方を持っているので、それを対応表として使う。
 * 既に nonce 台帳にある分は今セッションの確定値なので上書きしない。
 */
export function paradisMigrateProcessScopesToNonceScopes(
	nonceScopes: Map<string, string>,
	processScopes: ReadonlyMap<number, string>,
	nonceByPersistentProcessId: ReadonlyMap<number, string>,
): ReadonlyMap<string, string> {
	// 足した分だけを返す。呼び出し側が「読み側の全件」を書き側へ写すと、prune で落とした
	// 死んだ記録まで復活して保存され、台帳が単調に太って最後は保存上限で凍結する。
	const added = new Map<string, string>();
	for (const [persistentProcessId, stateKey] of processScopes) {
		const nonce = nonceByPersistentProcessId.get(persistentProcessId);
		if (nonce === undefined || !isValidNonce(nonce) || !isValidStateKey(stateKey) || nonceScopes.has(nonce)) {
			continue;
		}
		nonceScopes.set(nonce, stateKey);
		added.set(nonce, stateKey);
	}
	return added;
}

/** 所属を引くのに要るぶんだけの `IProcessDetails`。 */
export interface IParadisScopedProcessDetailLike {
	readonly id: number;
	readonly shellIntegrationNonce: string;
	readonly paradisRevivedFromPersistentProcessId?: number;
	readonly paradisAdopted?: boolean;
}

/**
 * ID 台帳を引くための ID を選ぶ。**引けない端末には `undefined` を返す。**
 *
 * ID 台帳の鍵は「前セッションの PTY ID」で、今セッションの ID とは別の空間にある。同じ小さな
 * 整数空間なので、今世代の ID で旧表を引くと**空振りでは済まず、別の端末の記録に当たる**。
 *
 * 引いてよいのは2つだけ:
 *
 *  - `paradisRevivedFromPersistentProcessId` がある（revive が前世代の ID を教えてくれている）
 *  - どちらでもない（リロードなどで ID が振り直されていない）
 *
 * **常駐から引き取った端末は前者に見えて後者ではない。** 新しい ID を渡されており、しかも
 * 前の ID は常駐に預けていないので復元しようがない。だからここでは引かず、`undefined` を返して
 * nonce 側に任せる（{@link paradisLookupProcessDetailScope}）。
 */
export function paradisProcessDetailScopeLookupId(detail: IParadisScopedProcessDetailLike): number | undefined {
	return paradisPreviousSessionPtyId({
		persistentProcessId: detail.id,
		restoredPersistentProcessId: detail.paradisRevivedFromPersistentProcessId,
		currentPersistentProcessIdOnly: detail.paradisAdopted === true,
	});
}

/**
 * PTY の一覧の1件から所属スペースを引く。
 *
 * ID 台帳と nonce 台帳の両方を見る。ID で引けるならそちらを優先し（{@link paradisResolveNonceScope}
 * と同じ理由）、引けないときだけ nonce に頼る。引き取った端末はここで初めて所属を取り戻す。
 */
export function paradisLookupProcessDetailScope(
	detail: IParadisScopedProcessDetailLike,
	processScopes: ReadonlyMap<number, string>,
	nonceScopes: ReadonlyMap<string, string>,
	onDisagreement?: (disagreement: IParadisTerminalNonceScopeDisagreement) => void,
): string | undefined {
	const lookupId = paradisProcessDetailScopeLookupId(detail);
	const processStateKey = lookupId === undefined ? undefined : processScopes.get(lookupId);
	return paradisResolveNonceScope(nonceScopes, detail.shellIntegrationNonce, processStateKey, onDisagreement);
}

/** nonce 台帳と ID 台帳が食い違ったときの記録。nonce の不変性を実機で確かめるために残す。 */
export interface IParadisTerminalNonceScopeDisagreement {
	readonly nonce: string;
	readonly nonceStateKey: string;
	readonly processStateKey: string;
}

/**
 * 復元された端末の所属を、nonce 台帳を先に引いて解決する。
 *
 * **食い違ったら ID 台帳を採る。** nonce が revive をまたいで本当に不変かはコードを追って
 * 確認した内容で、実機では未検証。もし崩れていた場合に、先に引く索引の方を信じると誤った
 * スペースへ寄せてしまう。従来の結果を変えないまま食い違いだけ観測できるようにしておく。
 */
export function paradisResolveNonceScope(
	nonceScopes: ReadonlyMap<string, string>,
	nonce: string | undefined,
	processStateKey: string | undefined,
	onDisagreement?: (disagreement: IParadisTerminalNonceScopeDisagreement) => void,
): string | undefined {
	if (!isValidNonce(nonce)) {
		return processStateKey;
	}
	const nonceStateKey = nonceScopes.get(nonce);
	if (nonceStateKey === undefined) {
		return processStateKey;
	}
	if (processStateKey !== undefined && processStateKey !== nonceStateKey) {
		onDisagreement?.({ nonce, nonceStateKey, processStateKey });
		return processStateKey;
	}
	return nonceStateKey;
}

/** 生きている端末に対応しない記録を落とす。ID 台帳の prune と同じ役割。 */
export function paradisPruneNonceScopes(nonceScopes: Map<string, string>, liveNonces: Iterable<string | undefined>): void {
	const live = new Set<string>();
	for (const nonce of liveNonces) {
		if (isValidNonce(nonce)) {
			live.add(nonce);
		}
	}
	for (const nonce of [...nonceScopes.keys()]) {
		if (!live.has(nonce)) {
			nonceScopes.delete(nonce);
		}
	}
}

/** 孤児 PTY 1件の「今世代の PTY ID」と、台帳が証明できた所有スペース。 */
export interface IParadisTerminalOrphanPtyOwner {
	readonly id: number;
	readonly stateKey: string;
}

/** 所有権の判定に必要な PTY 一覧の1件分。 */
export interface IParadisOrphanPtyDetailLike extends IParadisScopedProcessDetailLike {
	readonly workspaceId: string;
}

/**
 * 孤児 PTY の一覧から「nonce で引けて、かつ所有スペースを証明できるもの」だけを取り出す。
 *
 * **nonce の一致だけでは attach を許さない。** nonce は端末の同一性は示すが、所属スペースは
 * 示さない。台帳が所有者を答えられない、あるいは2つの台帳が食い違う端末をここで通すと、
 * スペースをまたいで端末が移動し、前のスペースの作業ディレクトリでコマンドを打つ事故になる。
 * したがって次の3つはいずれも除外する:
 *
 *  - 同じ nonce が2件以上ある（同一性を証明できない。先に見つかった方も含めて捨てる）
 *  - どちらの台帳も所有者を知らない
 *  - 復元時の台帳と現在の nonce 台帳が別のスペースを指している
 *
 * @param details `listProcesses()` が返した孤児 PTY の一覧。
 * @param workspaceId このウィンドウのワークスペース ID。別ワークスペースの PTY は対象外。
 * @param restoredPersistentProcessScopes 復元時点の ID 台帳。
 * @param restoredNonceScopes 復元時点の nonce 台帳。
 * @param nonceScopes 現在の nonce 台帳。
 */
export function paradisResolveOrphanPtyOwners(
	details: readonly IParadisOrphanPtyDetailLike[],
	workspaceId: string,
	restoredPersistentProcessScopes: ReadonlyMap<number, string>,
	restoredNonceScopes: ReadonlyMap<string, string>,
	nonceScopes: ReadonlyMap<string, string>,
): Map<string, IParadisTerminalOrphanPtyOwner> {
	const result = new Map<string, IParadisTerminalOrphanPtyOwner>();
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const detail of details) {
		const nonce = paradisTerminalIdentityNonce(detail.shellIntegrationNonce);
		if (nonce === undefined || detail.workspaceId !== workspaceId) {
			continue;
		}
		if (seen.has(nonce)) {
			duplicated.add(nonce);
			result.delete(nonce);
			continue;
		}
		seen.add(nonce);
		const restoredStateKey = paradisLookupProcessDetailScope(detail, restoredPersistentProcessScopes, restoredNonceScopes);
		const currentNonceStateKey = nonceScopes.get(nonce);
		if (restoredStateKey !== undefined && currentNonceStateKey !== undefined && restoredStateKey !== currentNonceStateKey) {
			continue;
		}
		const stateKey = currentNonceStateKey ?? restoredStateKey;
		if (stateKey === undefined) {
			continue;
		}
		result.set(nonce, { id: detail.id, stateKey });
	}
	for (const nonce of duplicated) {
		result.delete(nonce);
	}
	return result;
}
