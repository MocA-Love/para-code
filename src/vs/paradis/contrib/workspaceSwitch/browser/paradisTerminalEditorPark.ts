/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { IDeserializedTerminalEditorInput, ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { paradisTerminalIdentityNonce } from '../../mobileRelay/common/paradisTerminalPersistence.js';
import { paradisCurrentRestoreStateKey } from './paradisTerminalEditorRevive.js';

/**
 * エディタエリアのターミナルを Paradis ワークスペース切り替えを跨いで生かすためのパーク台帳 (機能1)。
 *
 * working set の入れ替えでターミナルエディタが閉じられると、通常は TerminalEditorInput.dispose()
 * がインスタンス（= PTY プロセス）ごと破棄する。一方 working set には persistentProcessId が
 * シリアライズされて残るため、切り替えで戻った際に既に死んだ pty へ attachToProcess を試みて
 * 「Could not find pty」で壊れたターミナルが復元されてしまう。
 *
 * そこで切り替え時 (ParadisWorkspaceSwitchService.switchToTarget) に、エディタターミナルの
 * インスタンスを input から切り離して殺さずにここへ登録し、working set 復帰時の
 * reviveInput (terminalEditorService.ts の PARA-PATCH) で pty 再接続の代わりに生きている
 * インスタンスをそのまま再利用する。パネルターミナルの park/unpark
 * (terminalGroupService.ts の PARA-PATCH) と対になる仕組み。
 *
 * park 中のインスタンスは、対応するスコープへ戻れば revive で再利用され、スコープが退役
 * (リポジトリ削除 / worktree 削除) すれば paradisRetireParkedTerminalEditorInstances で
 * 実体ごと破棄される。どちらの経路にも乗らない場合のみパネルの park と同様ウィンドウの寿命まで
 * 生存し、ウィンドウを閉じると pty host 側の孤児処理で回収される。
 *
 * 各エントリには park 元スコープの stateKey を併記する。working set の実体 (persistentProcessId を
 * 含むシリアライズ済みエディタ入力) は EditorParts 内部 storage にあり外部から列挙できないため、
 * 退役スコープの park インスタンスを特定するにはこの park 時点のタグに頼る。パネル側 _parkedGroups が
 * repositoryId でグループを束ねているのと対称。
 */
/**
 * キーは persistentProcessId ではなく shell integration nonce。
 *
 * persistentProcessId は「その pty host 世代の中でしか意味を持たない連番」で、`_lastPtyId` は
 * pty host が起動し直すたびに 0 から振り直される (ptyService.ts)。一方 working set は
 * 「そのスコープから離れる時」にしか書き直されないため、訪れていないスペースのスナップショットは
 * 何世代でも古いままになる。この2つを id で突き合わせると、**別スペースの別ターミナルが
 * たまたま同じ番号を持っているだけで取り違える**（実機で pty id 37 が2スペースに重複、
 * 一方は別スペースのエージェント端末だった）。
 *
 * nonce は revive を跨いで不変（`_reviveTerminalProcess` が `processLaunchConfig.options` を
 * そのまま渡し、`_buildProcessDetails` が同じ nonce を返す）ので、世代を跨いでも同一性を保証できる。
 */
const parkedInstances = new Map<string, { readonly instance: ITerminalInstance; readonly stateKey: string; readonly onDisposedListener: IDisposable }>();

/**
 * インスタンスを shell integration nonce をキーにパークする。
 * PTY ID 未確定・非永続・nonce 不正のインスタンスは登録しない。
 * stateKey は park 元スコープ (= 切り替え元の working set を保存したスコープ) の状態キー。
 */
export function paradisParkTerminalEditorInstance(instance: ITerminalInstance, stateKey: string): boolean {
	const nonce = paradisTerminalIdentityNonce(instance.shellIntegrationNonce);
	if (typeof instance.persistentProcessId !== 'number' || !instance.shouldPersist || nonce === undefined) {
		return false;
	}
	const existing = parkedInstances.get(nonce);
	if (existing) {
		if (existing.instance === instance) {
			// 同じインスタンスの再 park（stateKey が変わり得る）。下で貼り直すので古い方は畳む。
			existing.onDisposedListener.dispose();
			parkedInstances.delete(nonce);
		} else if (!existing.instance.isDisposed) {
			// 同じ nonce に別の生存インスタンスが居る = 同一 PTY への二重アタッチが既に起きている。
			// 黙って上書きすると追い出された側がどの一覧にも属さなくなり、park 台帳からも
			// unparkEditorTerminals からも retireScope からも回収できない不可視リークになる。
			// park を断れば、そのインスタンスは呼び出し元の管理下（エディタ入力）に留まる。
			return false;
		} else {
			existing.onDisposedListener.dispose();
			parkedInstances.delete(nonce);
		}
	}
	// パーク中にプロセスが終了した場合に台帳から漏れないよう掃除する
	const onDisposedListener = instance.onDisposed(() => {
		if (parkedInstances.get(nonce)?.instance === instance) {
			parkedInstances.delete(nonce);
		}
		onDisposedListener.dispose();
	});
	parkedInstances.set(nonce, { instance, stateKey, onDisposedListener });
	return true;
}

/**
 * 退役したスコープ (リポジトリ削除 / worktree 削除) の park 中エディタターミナルを実体ごと破棄する。
 * 破棄対象は「park 時に当該 stateKey でタグ付けされた」インスタンスのみ。park 台帳に居る =
 * どの UI にも接続されていない (revive で取り出されると台帳から消える) ため、現在表示中の
 * インスタンスや他スコープの park を誤って殺すことはない。
 *
 * instance.dispose() が onDisposed を発火して上の掃除リスナーが再入で台帳を触るのを避けるため、
 * 先に台帳から取り除きリスナーを解除してから dispose する。パネル側 retireScope が
 * instance.dispose(TerminalExitReason.User) で PTY ごと停止するのと対称に User 理由で破棄する。
 */
export function paradisRetireParkedTerminalEditorInstances(stateKey: string): void {
	const retiring: ITerminalInstance[] = [];
	for (const [nonce, entry] of [...parkedInstances]) {
		if (entry.stateKey !== stateKey) {
			continue;
		}
		parkedInstances.delete(nonce);
		entry.onDisposedListener.dispose();
		retiring.push(entry.instance);
	}
	for (const instance of retiring) {
		instance.dispose(TerminalExitReason.User);
	}
}

/**
 * 起動時の孤児ターミナル復活が完了したか。
 *
 * 完了前は台帳が空でも「このスコープに端末は無い」と断定できない。pty host に生きている
 * PTY が台帳へ戻ってくるのはこのフラグが立った後なので、それまでに「退避データ無し」と
 * 判定してスコープを捨てると、直後に復活した端末が到達不能な stateKey に取り残される。
 *
 * 立てられるのは復活処理を**一巡し切った**場合だけ。途中で中断したときに立ててはいけない。
 * 台帳が空なのは「端末が無い」からではなく「増やすはずだった処理を止めた」からで、
 * 前者と後者を取り違えると生きた PTY を退役の巻き添えにする。
 *
 * バックエンドに繋がらない等でフラグが立たないままになると、missing の自動退役はその
 * セッション中ずっと見送られる。復活してくる端末も無い状況なので、失うのは表示だけ。
 */
let orphanRevivalComplete = false;

export function paradisIsOrphanTerminalRevivalComplete(): boolean {
	return orphanRevivalComplete;
}

/** 孤児ターミナルの復活が一巡したことを記録する。復活対象が無かった場合も呼ぶこと。 */
export function paradisMarkOrphanTerminalRevivalComplete(): void {
	orphanRevivalComplete = true;
}

/**
 * 指定スコープにパーク中のエディタターミナルがあるか（台帳は変更しない）。
 * パーク中の端末は working set にも可視エディタ配置にも現れないので、
 * 「このスコープを捨ててよいか」を判断する側はここも見ないと PTY を巻き添えにする。
 */
export function paradisHasParkedTerminalEditorInstances(stateKey: string): boolean {
	for (const entry of parkedInstances.values()) {
		if (entry.stateKey === stateKey) {
			return true;
		}
	}
	return false;
}

/**
 * 指定した nonce が**すべて**そのスコープ向けにパークされたまま生きているか。
 *
 * 復元前に「孤児 PTY の索引を引く必要があるか」を判断するために使う。`reviveInput` は
 * **台帳を先に引き、当たれば索引を一切参照しない**（`terminalEditorService.ts` の PARA-PATCH）。
 * つまり復元対象の端末がすべてこの台帳に載っているなら、索引は誰も読まない。
 *
 * **件数の比較で代用してはいけない。** 台帳の母集団はそのスコープの working set に閉じておらず、
 * `assignInstanceScope` による付け替え park、起動時の孤児復活 park、切り替え失敗時の再 park で
 * **working set に無い端末が同じスコープへ載る**。一方 park 中に PTY が死ねばエントリだけ消える。
 * したがって「1つ死んで1つ余計に載っている」だけで件数は釣り合い、死んだ側の入力は台帳で
 * 引けないまま索引なしで ② の経路（upstream の `_revivedPtyIdMap`）へ落ちる。それは
 * このファイル冒頭が「取り違えより明確に悪い」と書いた多世代 misattach の窓そのもの。
 * だから**名指しで包含を確かめる**。
 */
export function paradisAreAllParkedForScope(nonces: ReadonlySet<string>, stateKey: string): boolean {
	for (const nonce of nonces) {
		const entry = parkedInstances.get(nonce);
		// `isDisposed` も見る。`onDisposed` 掃除は監視リスナーの張り替えを跨ぐ経路
		// （ドレイン → 再 park）があるため、閾値として使う以上は明示的に弾く。
		if (!entry || entry.stateKey !== stateKey || entry.instance.isDisposed) {
			return false;
		}
	}
	return true;
}

/**
 * パネル側の park 台帳（グループ単位）を引くための問い合わせ口。実体はターミナルスコープの
 * contribution が持っていて DI では循環するため、ここへ関数を預けてもらう形にしている。
 * 写しではなく実体を都度引くので、台帳の更新漏れで食い違うことがない。
 */
let parkedGroupProbe: ((stateKey: string) => boolean) | undefined;

export function paradisRegisterParkedTerminalGroupProbe(probe: (stateKey: string) => boolean): IDisposable {
	parkedGroupProbe = probe;
	return toDisposable(() => {
		if (parkedGroupProbe === probe) {
			parkedGroupProbe = undefined;
		}
	});
}

/**
 * 指定スコープにパーク中のターミナルがあるか（エディタ側・パネル側の両方）。
 * スコープを捨てる前の判定はこちらを使うこと。エディタ側だけ見ると、
 * 端末グリッド（パネル側）しか置いていないスペースを巻き添えにする。
 */
export function paradisHasParkedTerminals(stateKey: string): boolean {
	return paradisHasParkedTerminalEditorInstances(stateKey) || (parkedGroupProbe?.(stateKey) ?? false);
}

/**
 * パーク中の全インスタンスを列挙する（台帳からは取り出さない）。
 * モバイルリレーが「他ワークスペースへ退避中のエディタターミナル」も一覧・attach できるようにするための読み取り専用ビュー。
 * terminalService.instances にも paradisParkedGroups にも現れないのはこの台帳のインスタンスだけなので、
 * 全ターミナル列挙はこの3つの合算で完全になる。
 */
export function paradisListParkedTerminalEditorInstances(): ITerminalInstance[] {
	return [...parkedInstances.values()].map(e => e.instance);
}

/**
 * park中インスタンスの instanceId → park元スコープの stateKey を引く（スコープ解決用）。
 * エディタエリアのターミナルはパネルのグループ台帳 (_groupRepositories) に乗らないため、
 * IParadisTerminalScopeService.getStateKeyForInstance がこの台帳を第二の解決先として使う。
 */
export function paradisGetParkedTerminalEditorStateKey(instanceId: number): string | undefined {
	for (const entry of parkedInstances.values()) {
		if (entry.instance.instanceId === instanceId) {
			return entry.stateKey;
		}
	}
	return undefined;
}

/**
 * 指定スコープの park 中インスタンスをすべて取り出す（台帳から消え、監視リスナーも解除される）。
 *
 * エディタターミナルの復元は本来 working set の deserialize → reviveInput
 * (terminalEditorService.ts の PARA-PATCH) が担うが、復路で適用される working set が
 * park した世代と一致しない場合など、reviveInput の台帳ルックアップに到達しないことがある。
 * その場合インスタンスは誰にも回収されず PTY だけが不可視のまま生き続ける（リーク）。
 * スコープ切り替え完了時にこの関数で残留分を回収し、明示的にエディタとして開き直す
 * フォールバックに使う（paradisTerminalScope.contribution.ts の applyScope）。
 */
export function paradisTakeParkedTerminalEditorInstancesForScope(stateKey: string): ITerminalInstance[] {
	const taken: ITerminalInstance[] = [];
	for (const [nonce, entry] of [...parkedInstances]) {
		if (entry.stateKey !== stateKey) {
			continue;
		}
		parkedInstances.delete(nonce);
		entry.onDisposedListener.dispose();
		taken.push(entry.instance);
	}
	return taken;
}

/**
 * 直列化されたエディタ入力に対応するパーク済みインスタンスを取り出す
 * （一度取り出したら台帳から消え、監視リスナーも解除される）。
 *
 * 突き合わせは nonce のみで行う。`deserializedInput.id` は保存した世代の pty id で、
 * 現在の台帳キーとは別の番号空間にあるため、一致しても同一性の証拠にならない。
 * nonce が無い（型上は必須だが実行時ガードは `'id' in obj && 'pid' in obj` しか見ていない）
 * 入力は同一性を証明できないので、park を再利用せず通常の attach 経路へ委ねる。
 */
export function paradisTakeParkedTerminalEditorInstance(deserializedInput: IDeserializedTerminalEditorInput): ITerminalInstance | undefined {
	const nonce = paradisTerminalIdentityNonce(deserializedInput.shellIntegrationNonce);
	if (nonce === undefined) {
		return undefined;
	}
	const entry = parkedInstances.get(nonce);
	if (!entry) {
		return undefined;
	}
	// nonce は「どの端末か」は証明するが「どのスペースのものか」は証明しない。スペース復元中は
	// 所有スコープの一致まで要求し、「正しい端末を、間違ったスペースへ出す」を残さない。
	const expectedStateKey = paradisCurrentRestoreStateKey();
	if (expectedStateKey !== undefined && entry.stateKey !== expectedStateKey) {
		return undefined;
	}
	parkedInstances.delete(nonce);
	entry.onDisposedListener.dispose();
	return entry.instance;
}
