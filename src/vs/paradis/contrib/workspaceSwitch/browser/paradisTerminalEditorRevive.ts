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
import { PARADIS_UNRESOLVABLE_PTY_ID } from '../../../../platform/terminal/common/terminal.js';
import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { setParadisSpanAttributes } from '../../sentry/common/paradisSentryDiagnostics.js';

/** 索引取得に許す時間。取れなければ諦めて安全側（空）へ倒す。 */
const PARADIS_REVIVE_INDEX_TIMEOUT_MS = 500;

export interface IParadisTerminalReviveIndexSource {
	/** 孤児 PTY（どの renderer にも掴まれていないもの）の nonce → 現世代 PTY と所有スコープ。 */
	listOrphanPtyIdsByNonce(): Promise<ReadonlyMap<string, IParadisTerminalOrphanPty>>;
	/** このウィンドウのインスタンスが今まさに掴んでいる PTY ID。同期で読めること。 */
	listHeldPtyIds(): ReadonlySet<number>;
}

export interface IParadisTerminalOrphanPty {
	readonly id: number;
	readonly stateKey: string;
}

interface IParadisTerminalReviveContext {
	readonly id: number;
	readonly handle: IDisposable;
	readonly targetStateKey: string;
	readonly expectedNonces: ReadonlySet<string> | undefined;
	orphanPtyByNonce: ReadonlyMap<string, IParadisTerminalOrphanPty>;
}

type ParadisTerminalRestoreResolution =
	| { readonly kind: 'match'; readonly context: IParadisTerminalReviveContext }
	| { readonly kind: 'ambiguous' }
	| { readonly kind: 'unrelated' };

let source: IParadisTerminalReviveIndexSource | undefined;
let nextContextId = 1;
const restoreContexts = new Map<number, IParadisTerminalReviveContext>();

function disposeAllRestoreContexts(): void {
	for (const context of [...restoreContexts.values()]) {
		context.handle.dispose();
	}
}

function resolveRestoreContext(nonce: string): ParadisTerminalRestoreResolution {
	const exact = [...restoreContexts.values()].filter(context => context.expectedNonces?.has(nonce));
	const legacy = [...restoreContexts.values()].filter(context => context.expectedNonces === undefined);
	// The synchronous revive callback cannot tell whether an input came from an exact or a legacy
	// Working Set. If both overlap, selecting the exact entry could let a legacy restore consume
	// another space's PTY.
	if (exact.length > 0 && legacy.length > 0) {
		return { kind: 'ambiguous' };
	}
	if (exact.length === 1) {
		return { kind: 'match', context: exact[0] };
	}
	if (exact.length > 1) {
		return { kind: 'ambiguous' };
	}
	// Legacy Working Sets did not persist their nonce list. A single in-flight legacy restore can
	// still safely reuse a parked terminal by checking its owner against this target. If another
	// legacy restore overlaps, there is no synchronous evidence that identifies the caller.
	if (legacy.length === 1) {
		return { kind: 'match', context: legacy[0] };
	}
	return legacy.length > 1 ? { kind: 'ambiguous' } : { kind: 'unrelated' };
}

/**
 * 今まさに復元する Working Set が直列化していた nonce ごとのスコープ。
 * park 台帳の払い出しに「そのスコープが所有していること」まで要求できる。
 *
 * nonce は *どの端末か* は証明するが *どのスペースのものか* は証明しない。`assignInstanceScope`
 * で端末のスペースを付け替えられる以上、複数スペースの working set に同じ nonce が残る構成は
 * 作れてしまい、その場合「正しい端末を、間違ったスペースへ出す」が残る。これはユーザーから見た
 * 症状が元のバグと区別できないので、復元中だけ所有権も突き合わせる。
 *
 * 切替以外の経路（起動時のエディタ復元など）では undefined のままなので、従来どおり nonce だけで判定する。
 */
export function paradisTerminalRestoreStateKey(shellIntegrationNonce: string | undefined): string | undefined {
	const nonce = paradisTerminalIdentityNonce(shellIntegrationNonce);
	if (nonce === undefined) {
		return undefined;
	}
	const resolution = resolveRestoreContext(nonce);
	return resolution.kind === 'match' ? resolution.context.targetStateKey : undefined;
}

/** True when an active restore may own this input but its target cannot be proven uniquely. */
export function paradisIsTerminalRestoreInputAmbiguous(shellIntegrationNonce: string | undefined): boolean {
	const nonce = paradisTerminalIdentityNonce(shellIntegrationNonce);
	if (nonce === undefined) {
		return [...restoreContexts.values()].some(context => context.expectedNonces === undefined);
	}
	return resolveRestoreContext(nonce).kind === 'ambiguous';
}

/** 索引の供給元を登録する（renderer ローカル。paradisTerminalScope.contribution.ts から）。 */
export function paradisRegisterTerminalReviveIndexSource(value: IParadisTerminalReviveIndexSource): IDisposable {
	source = value;
	return toDisposable(() => {
		if (source === value) {
			source = undefined;
			disposeAllRestoreContexts();
		}
	});
}

/**
 * 孤児スナップショットを取り直す。working set を適用する直前に一度だけ await すること
 * （`reviveInput` は同期なので、そこから非同期に取りにいけない）。
 * 失敗しても投げない: 索引が空なら「正体が確認できない」と同じ扱いになり、安全側に倒れる。
 */
export async function paradisRefreshTerminalReviveIndex(
	targetStateKey: string,
	options?: {
		readonly skipLookup?: boolean;
		readonly skipReason?: 'no-terminals' | 'covered-by-park';
		/** 前回この手でパークした端末の数。判定の裏取り用。 */
		readonly parkedCount?: number;
		/** working set 保存時の端末数。`parked > expected` が常態なら件数比較は危険だった証拠。 */
		readonly expectedCount?: number;
		/**
		 * skip を諦めた理由（skip が成立した回は `undefined`）。
		 * `no-ledger` = nonce台帳そのものが無い（そのスペースをまだ一度も離れていない等）、
		 * `unknown-expected` = 復元する端末数が不明、`count-short` = park が端末数に届かない、
		 * `not-all-parked` = 数は足りるが顔ぶれが違う。
		 */
		readonly blockReason?: 'no-ledger' | 'unknown-expected' | 'count-short' | 'not-all-parked';
		/** Exact terminal inputs serialized in the target Working Set. Legacy data is represented by undefined. */
		readonly expectedNonces?: ReadonlySet<string>;
	},
): Promise<IDisposable> {
	let expectedNonces: Set<string> | undefined;
	if (options?.expectedNonces !== undefined) {
		expectedNonces = new Set();
	}
	for (const nonce of options?.expectedNonces ?? []) {
		const identity = paradisTerminalIdentityNonce(nonce);
		if (identity !== undefined) {
			expectedNonces?.add(identity);
		}
	}
	const id = nextContextId++;
	const handle = toDisposable(() => restoreContexts.delete(id));
	const context: IParadisTerminalReviveContext = {
		id,
		handle,
		targetStateKey,
		expectedNonces,
		orphanPtyByNonce: new Map(),
	};
	// 復元先にターミナルエディタが1つも無いと分かっている場合、索引は誰も引かない。本番では
	// 最も遅い60件のうち58件で孤児が0、半分が締め切り（500ms）に張り付いており、pty host の
	// 応答を待って空の索引を受け取るだけの回が大半を占めていた。
	//
	// 誤って skip しても復元中の旧ID attach は fail-closed だが、本来のPTYを再利用できず新規端末に
	// なる。データ継続性を落とさないため、呼び出し側は数えられない場合を「不明＝引く」に倒す。
	//
	// `safe_orphans` を送らないのは意図的。ここで 0 を送ると「問い合わせた結果、孤児が0だった」
	// 回と混ざり、この変更を正当化した観測そのものが読めなくなる。
	if (options?.skipLookup) {
		// 理由まで残す。`covered-by-park` が想定どおり多数を占めるか、`no-terminals` しか
		// 効いていないかで、次に詰める場所が変わる。
		setParadisSpanAttributes({
			safe_timed_out: false,
			safe_index_skipped: true,
			safe_index_skip_reason: options.skipReason ?? 'unspecified',
			safe_index_parked: options.parkedCount ?? -1,
			safe_index_expected: options.expectedCount ?? -1,
		});
		restoreContexts.set(context.id, context);
		return handle;
	}
	if (source === undefined) {
		restoreContexts.set(context.id, context);
		return handle;
	}
	// `listProcesses` は pty host への IPC で、`_isOrphaned` が
	// renderer 応答を `AutoOpenBarrier(4000)` で待つ経路もあり、無制限に待たせると
	// 対応する切替本体が進まない。索引が空でも、同一セッション内の切替は park 台帳が nonce で
	// 解決し、索引が効かない入力は復元コンテキストの fail-closed ガードに倒れる。
	// ここは切替の本流にいる。索引が取れないことは「復元の質が落ちる」だけで切替の失敗ではないので、
	// 例外を外へ出してロールバックを誘発させない。
	try {
		const resolved = await raceTimeout(
			source.listOrphanPtyIdsByNonce(),
			PARADIS_REVIVE_INDEX_TIMEOUT_MS,
		);
		context.orphanPtyByNonce = resolved ?? new Map();
		// 索引が空のまま進む回がどれだけあるかは、復元の質に直結する（空だと nonce で引けず
		// 従来経路に落ちる）。締め切り切れと「孤児が本当にいない」は結果が同じで区別できない
		// ので、打ち切りかどうかを明示的に残す。
		// `safe_index_skipped: false` を明示的に送る。省くと Sentry 側で「属性なし」が
		// 「skip していない」と「この計装より前のビルド」の両方を意味してしまう。
		setParadisSpanAttributes({
			safe_timed_out: resolved === undefined,
			safe_orphans: context.orphanPtyByNonce.size,
			safe_index_skipped: false,
			// **skip できなかった回にも台帳の数を送る。** これまでは skip 分岐でしか送って
			// いなかったため、「なぜ skip が 3% しか成立しないのか」を本番データから一切
			// 追えなかった（Sentry 上でも両方を持つ span は0件だった）。
			safe_index_parked: options?.parkedCount ?? -1,
			safe_index_expected: options?.expectedCount ?? -1,
			// どの条件で skip を諦めたか。数が足りないのか、台帳自体が無いのか、顔ぶれが
			// 違うのかで次に直す場所が変わる。
			safe_index_block_reason: options?.blockReason ?? 'unspecified',
		});
	} catch (error) {
		context.orphanPtyByNonce = new Map();
		setParadisSpanAttributes({ safe_timed_out: false, safe_orphans: 0, safe_failed: true });
		onUnexpectedError(error);
	}
	// Publish only after the asynchronous lookup. Until applyWorkingSet starts, unrelated restore
	// paths must not observe this context and turn a healthy attachment into a new shell.
	restoreContexts.set(context.id, context);
	return handle;
}

/**
 * 全復元コンテキストを捨てるテスト・終了処理用の非常口。通常は refresh が返した handle を dispose する。
 *
 * 索引は「今から適用する working set のための使い捨てスナップショット」なので、残しておくと
 * ロールバックでの再適用や、切替と無関係な後続の revive（起動時のエディタ復元、補助ウィンドウ
 * 復元、`unparkEditorTerminals` の失敗経路）が古い情報で attach 先を決めてしまう。
 * 捨てておけば、refresh していない全経路は「索引空＝安全側」に揃う。
 */
export function paradisClearTerminalReviveIndex(): void {
	disposeAllRestoreContexts();
}

/**
 * 直列化された入力を、実際に attach してよい対象へ解決する。
 *
 * 1. nonce で孤児 PTY が引ければ、その現世代 ID へ**書き換えて** `findRevivedId: false` で繋ぐ。
 *    `_revivedPtyIdMap` の世代問題を完全に迂回できる。
 * 2. 引けなくても nonce で身元が定まるなら、数値 ID のまま `findRevivedId: true` へ委ねる。
 *    行き先の `getRevivedPtyNewId` が nonce を照合するので、そこが最終的な安全弁になる。
 * 3. 身元が一意に決まらない（`ambiguous`）か、その `id` を今このウィンドウの誰かが掴んで
 *    いるときだけ、数値 ID へ触らず新規端末へ倒す。
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
	const restoreResolution = nonce === undefined
		? ([...restoreContexts.values()].some(context => context.expectedNonces === undefined) ? { kind: 'ambiguous' } as const : { kind: 'unrelated' } as const)
		: resolveRestoreContext(nonce);
	const restoreContext = restoreResolution.kind === 'match' ? restoreResolution.context : undefined;
	if (nonce !== undefined && !heldPtyIdsUnknown) {
		const orphanPty = restoreContext?.orphanPtyByNonce.get(nonce);
		// 索引はスナップショットなので、払い出す直前に「まだ誰も掴んでいない」ことを確かめる。
		// 払い出したエントリは必ず消す。1回の refresh に対して resolve は何度でも走る
		// （working set 内の各入力・補助ウィンドウ復元・ロールバックでの再適用）ため、
		// 消さないと同じ PTY ID を2度払い出し、まさにこの修正が防ぎたい二重アタッチになる。
		if (orphanPty !== undefined
			&& orphanPty.stateKey === restoreContext?.targetStateKey
			&& heldPtyIds?.has(orphanPty.id) !== true) {
			const remaining = new Map(restoreContext.orphanPtyByNonce);
			remaining.delete(nonce);
			restoreContext.orphanPtyByNonce = remaining;
			return { ...deserializedInput, id: orphanPty.id, findRevivedId: false, paradisResolvedToCurrentPtyId: true };
		}
	}

	// 索引で引けなかった入力を新規端末へ倒すのは、身元が**まったく**定まらないときだけにする。
	// nonce がある入力の行き先（`findRevivedId: true` → `attachToRevivedProcess(id, nonce)` →
	// `PtyService.getRevivedPtyNewId`）は、この fork が既に nonce 照合を入れてあり、別端末を
	// 指していれば `PARADIS_UNRESOLVABLE_PTY_ID` を返す fail-closed 経路。世代跨ぎの取り違えは
	// そこで塞がれるので、ここで重ねて塞ぐ必要はない。
	//
	// **ここを `kind !== 'unrelated'` にしないこと。** 索引は `raceTimeout(500ms)` で落ちうるし、
	// 所有権フィルタで孤児が落ちることもある。「索引ミス＝新規シェル」にすると、pty host が
	// 遅いだけの回に生きているシェルのセッションを黙って捨てることになり、この索引が防ごうと
	// している取り違えより実害が大きい。塞ぐのは身元を一意に決められない `ambiguous` だけ。
	if (restoreResolution.kind === 'ambiguous' || heldPtyIdsUnknown || heldPtyIds?.has(deserializedInput.id) === true) {
		return { ...deserializedInput, id: PARADIS_UNRESOLVABLE_PTY_ID, findRevivedId: false };
	}

	return { ...deserializedInput, findRevivedId: true };
}
