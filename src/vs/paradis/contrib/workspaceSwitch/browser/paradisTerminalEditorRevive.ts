/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// working set から復元されるターミナルエディタ入力を、どの PTY へ繋ぐか決める解決役。
//
// なぜ必要か:
// 直列化されたエディタ入力が持つ `id` は「保存した世代の persistentProcessId」でしかない。
// pty host の採番カウンタ `_lastPtyId` は host が起動し直すたびに 0 に戻るため（アプリ終了時
// だけでなくクラッシュや restartPtyHost でも起きる）、id は世代を跨ぐと別のターミナルを指す。
// working set は「そのスコープから離れる時」にしか書き直されないので、訪れていないスペースの
// スナップショットは何世代でも古いまま残る。
//
// upstream の `attachToRevivedProcess` は `_revivedPtyIdMap`（旧 id → 新 id）で補正するが、
// この表は **起動時の reviveTerminalProcesses が作る「直前の1世代」分しか持たない**。しかも
// `_expandTerminalInstance` が使ったエントリを delete するため、パネル復元が先に消費した id は
// 生の id のまま attach に落ちる。つまり多世代前のスナップショットは補正されない。
//
// 補正されないまま attach すると何が起きるか（実装で確認済み）:
// pty host 側 `attach()` は猶予タイマーを止めるだけで先客を切断も拒否もしない。renderer 側は
// `localTerminalBackend.attachToProcess` が `this._ptys.set(id, pty)` を無条件に行うので、
// 同じ id への2度目の attach で **先客の LocalPty がマップから静かに追い出される**。追い出された
// 側は onProcessData / onProcessExit を受け取らなくなり、画面が固まったまま onDisposed も
// 永久に発火しない（park 台帳の自動掃除も効かない）。書き込みだけは同じ PTY に通り、
// どちらかを閉じれば PTY ごと道連れになる。取り違えより明確に悪い。
//
// したがってここが守る不変条件は「nonce が一致した時だけ再利用する」ではなく、
// **「nonce で正体が確認できない PTY ID には触らない」**。
//
// 索引の作り方:
// `listProcesses()` は最後に `filter(entry => entry.isOrphan)` しているので、返ってくるのは
// 「今どの renderer にも掴まれていない PTY」だけ。park 中インスタンスは LocalPty が孤児判定に
// 応答するので非孤児となり索引に出ない。つまりこの索引はそのまま
// **「安全に attach してよい候補」** になる。

import { raceTimeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { IDeserializedTerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';

/**
 * 存在しないことが保証される PTY ID。`findRevivedId: false` と併せて使うと
 * `attachToProcess` が undefined を返し、upstream が `attachPersistentProcess` を捨てて
 * 新しいシェルを起動する既定の失敗経路に乗る（terminalProcessManager.ts）。
 * 空のターミナルが1枚開くだけで、他スコープの生きた PTY を壊さない。
 */
const PARADIS_UNRESOLVABLE_PTY_ID = -1;

/** 索引取得に許す時間。切替の直列パス上なので、取れなければ諦めて安全側（空）へ倒す。 */
const PARADIS_REVIVE_INDEX_TIMEOUT_MS = 500;

export interface IParadisTerminalReviveIndexSource {
	/** 孤児 PTY（どの renderer にも掴まれていないもの）の nonce → 現世代 PTY ID。 */
	listOrphanPtyIdsByNonce(): Promise<ReadonlyMap<string, number>>;
	/** このウィンドウのインスタンスが今まさに掴んでいる PTY ID。同期で読めること。 */
	listHeldPtyIds(): ReadonlySet<number>;
}

let source: IParadisTerminalReviveIndexSource | undefined;
let orphanPtyIdByNonce: ReadonlyMap<string, number> = new Map();
let restoreStateKey: string | undefined;

/**
 * 今まさに復元しようとしているスコープ。設定されている間は、park 台帳の払い出しに
 * 「そのスコープが所有していること」まで要求できる（paradisTerminalEditorPark.ts）。
 *
 * nonce は *どの端末か* は証明するが *どのスペースのものか* は証明しない。`assignInstanceScope`
 * で端末のスペースを付け替えられる以上、複数スペースの working set に同じ nonce が残る構成は
 * 作れてしまい、その場合「正しい端末を、間違ったスペースへ出す」が残る。これはユーザーから見た
 * 症状が元のバグと区別できないので、復元中だけ所有権も突き合わせる。
 *
 * 切替以外の経路（起動時のエディタ復元など）では undefined のままなので、従来どおり nonce だけで判定する。
 */
export function paradisCurrentRestoreStateKey(): string | undefined {
	return restoreStateKey;
}

/** 索引の供給元を登録する（renderer ローカル。paradisTerminalScope.contribution.ts から）。 */
export function paradisRegisterTerminalReviveIndexSource(value: IParadisTerminalReviveIndexSource): IDisposable {
	source = value;
	return toDisposable(() => {
		if (source === value) {
			source = undefined;
			orphanPtyIdByNonce = new Map();
		}
	});
}

/**
 * 孤児スナップショットを取り直す。working set を適用する直前に一度だけ await すること
 * （`reviveInput` は同期なので、そこから非同期に取りにいけない）。
 * 失敗しても投げない: 索引が空なら「正体が確認できない」と同じ扱いになり、安全側に倒れる。
 */
export async function paradisRefreshTerminalReviveIndex(targetStateKey: string): Promise<void> {
	restoreStateKey = targetStateKey;
	if (source === undefined) {
		return;
	}
	// スペース切替は `_switchSequencer` で直列化されているので、ここでの待ちは後続の切替を
	// そのままブロックする。`listProcesses` は pty host への IPC で、`_isOrphaned` が
	// renderer 応答を `AutoOpenBarrier(4000)` で待つ経路もあり、無制限に待たせると
	// 「pty host が無応答の間ずっと切替できない」になる。索引が空でも、同一セッション内の
	// 切替は park 台帳が nonce で解決し、索引が効かない入力は held ガードで安全側に倒れるだけ。
	// ここは切替の本流にいる。索引が取れないことは「復元の質が落ちる」だけで切替の失敗ではないので、
	// 例外を外へ出してロールバックを誘発させない。
	try {
		orphanPtyIdByNonce = await raceTimeout(
			source.listOrphanPtyIdsByNonce(),
			PARADIS_REVIVE_INDEX_TIMEOUT_MS,
		) ?? new Map();
	} catch (error) {
		orphanPtyIdByNonce = new Map();
		onUnexpectedError(error);
	}
}

/**
 * 索引を捨てる。適用が終わったら必ず呼ぶこと。
 *
 * 索引は「今から適用する working set のための使い捨てスナップショット」なので、残しておくと
 * ロールバックでの再適用や、切替と無関係な後続の revive（起動時のエディタ復元、補助ウィンドウ
 * 復元、`unparkEditorTerminals` の失敗経路）が古い情報で attach 先を決めてしまう。
 * 捨てておけば、refresh していない全経路は「索引空＝安全側」に揃う。
 */
export function paradisClearTerminalReviveIndex(): void {
	orphanPtyIdByNonce = new Map();
	restoreStateKey = undefined;
}

/**
 * 直列化された入力を、実際に attach してよい対象へ解決する。
 *
 * 1. nonce で孤児 PTY が引ければ、その現世代 ID へ**書き換えて** `findRevivedId: false` で繋ぐ。
 *    `_revivedPtyIdMap` の世代問題を完全に迂回できる。
 * 2. 引けない場合、その `id` を今このウィンドウの誰かが掴んでいるなら**絶対に触らない**。
 * 3. どちらでもなければ従来どおり（レガシーな working set の救済経路）。
 */
export function paradisResolveRevivedTerminalEditorInput(deserializedInput: IDeserializedTerminalEditorInput): IDeserializedTerminalEditorInput & { findRevivedId: boolean } {
	// 供給元が未登録なら（起動直後のエディタ復元など、このサービスが立ち上がる前）判定材料が
	// 無いので従来経路に委ねる。登録済みなのに問い合わせが失敗した場合は話が別で、安全弁が
	// 最も必要な場面で安全弁を外すことになるため「全部使用中」と同じ扱い（fail-closed）にする。
	let heldPtyIds: ReadonlySet<number> | undefined;
	let heldPtyIdsUnknown = false;
	if (source !== undefined) {
		try {
			heldPtyIds = source.listHeldPtyIds();
		} catch (error) {
			onUnexpectedError(error);
			heldPtyIdsUnknown = true;
		}
	}

	const nonce = paradisTerminalIdentityNonce(deserializedInput.shellIntegrationNonce);
	if (nonce !== undefined && !heldPtyIdsUnknown) {
		const orphanPtyId = orphanPtyIdByNonce.get(nonce);
		// 索引はスナップショットなので、払い出す直前に「まだ誰も掴んでいない」ことを確かめる。
		// 払い出したエントリは必ず消す。1回の refresh に対して resolve は何度でも走る
		// （working set 内の各入力・補助ウィンドウ復元・ロールバックでの再適用）ため、
		// 消さないと同じ PTY ID を2度払い出し、まさにこの修正が防ぎたい二重アタッチになる。
		if (orphanPtyId !== undefined && heldPtyIds?.has(orphanPtyId) !== true) {
			const remaining = new Map(orphanPtyIdByNonce);
			remaining.delete(nonce);
			orphanPtyIdByNonce = remaining;
			return { ...deserializedInput, id: orphanPtyId, findRevivedId: false };
		}
	}

	if (heldPtyIdsUnknown || heldPtyIds?.has(deserializedInput.id) === true) {
		return { ...deserializedInput, id: PARADIS_UNRESOLVABLE_PTY_ID, findRevivedId: false };
	}

	return { ...deserializedInput, findRevivedId: true };
}
