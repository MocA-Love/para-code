/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 資料のコメントを持ち主のペインへ届ける決まり（純関数）と、ウィンドウ ⇄ shared process の届け方のチャネルの形。
//
// 決めるのは shared process（hook から分かるペインの状態・入力欄の mod の書きかけを持つ）で、貼るのはペインを持つ
// ウィンドウ。ウィンドウは「届けたいペインがある」の知らせを受けて自分のペインの分を取りに行き（claim）、貼った後に
// Enter の直前でもう一度確かめる（confirmEnter）。取り合いは shared process で 1 つに絞る（ペインごとに 1 件ずつ）。
//
// ペインへ貼るのは定型文とコメントの ID、ユーザーが打った文の先頭 1 行だけ（Q667-5）。資料から引用した文は貼らない
// （ユーザーの発言として届くと、資料の中の文が指示として読まれうるため）。引用と位置は read_doc_comments で読ませる。

import { localize } from '../../../../nls.js';
import type { ParadisAgentStatus } from '../../agentBrowser/common/paradisAgentBrowser.js';
import { paradisIsInsideFolder } from './paradisAgentDocs.js';
import { ParadisDocDeliveryBlock } from './paradisDocComments.js';

/** shared process の届け方のチャネル。 */
export const PARADIS_DOC_DELIVERY_CHANNEL = 'paradisDocCommentDelivery';
/** 届けたいペインがある（ペインのトークンの配列）。ウィンドウは自分のペインの分だけ取りに行く。 */
export const PARADIS_DOC_DELIVERY_WANTED_EVENT = 'onDidWant';
/** 届ける分を取る。引数は `[token]`、答えは {@link IParadisDocDeliveryClaim} か undefined（今は届けない）。 */
export const PARADIS_DOC_DELIVERY_CLAIM_METHOD = 'claim';
/** 貼った後、Enter を送ってよいか確かめ直す。引数は `[attempt]`、答えは boolean。 */
export const PARADIS_DOC_DELIVERY_CONFIRM_METHOD = 'confirmEnter';
/** 取った分の結果を知らせる。引数は `[attempt, ParadisDocDeliveryOutcome]`。 */
export const PARADIS_DOC_DELIVERY_FINISH_METHOD = 'finish';
/**
 * 終了した持ち主の会話を起こす券を取る（カードの「起こして届ける」）。引数は `[hostId, path, windowIsRemote]`、答えは
 * {@link ParadisDocWakeAnswer}。券を渡した時点で、その会話は「起こしている途中」になり、二度目の券は出ない。
 */
export const PARADIS_DOC_DELIVERY_WAKE_METHOD = 'wake';
/** 起こしたペインを知らせる。引数は `[session, paneToken | undefined]`。 */
export const PARADIS_DOC_DELIVERY_WOKE_METHOD = 'woke';
/** 起こせなかった・起こしたターミナルで CLI が終わった。引数は `[session, paneToken?]`（渡したときは、そのペインで起こした分だけを外す）。 */
export const PARADIS_DOC_DELIVERY_WAKE_FAILED_METHOD = 'wakeFailed';
/** 持ち主のいない・終了した持ち主の資料を、選んだペインの会話へ渡す（カードの「別のエージェントに渡す」）。引数は `[hostId, path, token]`。 */
export const PARADIS_DOC_DELIVERY_HAND_OFF_METHOD = 'handOff';

/** ウィンドウが取った、1 回の貼り付け。 */
export interface IParadisDocDeliveryClaim {
	/** この貼り付けの印（confirmEnter・finish で返す）。 */
	readonly attempt: string;
	/** 貼る 1 行。 */
	readonly text: string;
	/** 貼った後に Enter も送るか（SSH 先のペイン・許可待ちが確かめられないまま解けたペインは送らない）。 */
	readonly enter: boolean;
}

/**
 * ウィンドウが知らせる結果。`entered`: 貼って Enter も送った、`typed`: 貼ったが Enter は送らなかった（ユーザーが送る）、
 * `screen`: 画面に確認が出ていた・画面を読めなかったので貼らなかった、`notRunning`: 前面でエージェントが動いていない
 * （シェルへ貼ると行として実行される）ので貼らなかった、`gone`: ペインが見つからない・閉じた・貼れなかった。
 */
export type ParadisDocDeliveryOutcome = 'entered' | 'typed' | 'screen' | 'notRunning' | 'gone';
const OUTCOMES: ReadonlySet<string> = new Set<ParadisDocDeliveryOutcome>(['entered', 'typed', 'screen', 'notRunning', 'gone']);

export function paradisReadDocDeliveryOutcome(value: unknown): ParadisDocDeliveryOutcome | undefined {
	return typeof value === 'string' && OUTCOMES.has(value) ? value as ParadisDocDeliveryOutcome : undefined;
}

// --- 届けてよいか -----------------------------------------------------------------------------

/** 持ち主の会話の見え方。live = その会話がどれかのペインで動いている、waking = ユーザーが起こし、CLI の起動を待っている。 */
export type ParadisDocDeliveryOwner = 'none' | 'ended' | 'unknown' | 'waking' | 'live';

/** 入力欄の中身。`unknown` は確かめる手段が無い（Codex・入力欄の mod の無い Claude Code など）。 */
export type ParadisDocDraftState = 'empty' | 'text' | 'unknown';

export interface IParadisDocDeliveryInput {
	readonly owner: ParadisDocDeliveryOwner;
	/** 持ち主のペインから本物の hook が一度でも届いたか。 */
	readonly hasHooks: boolean;
	/** hook から分かるペインの状態（undefined は待機中）。 */
	readonly status: ParadisAgentStatus | undefined;
	/** 許可待ちが hook 以外から解かれ、確かめた hook がまだ来ていない。 */
	readonly unconfirmedRelease: 'pending' | 'unverifiable' | undefined;
	readonly draft: ParadisDocDraftState;
	/** ターンが終わった直後（入力欄の中身が分からないときは、この間だけ入れる）。 */
	readonly turnJustEnded: boolean;
	/** ユーザーがカードの「今すぐ届ける」を押した（入力欄の中身が分からなくても入れる。ほかの条件は変えない）。 */
	readonly forced: boolean;
	/** 持ち主のペインが SSH 先で動いている（状態の知らせを偽れるので Enter は送らない）。 */
	readonly remote: boolean;
	/** 同じペインへ前の分を貼って、届いた知らせを待っている。 */
	readonly busy: boolean;
	/** 起こしたばかりのペインで、CLI の起動の猶予がまだ過ぎていない。 */
	readonly starting?: boolean;
}

export type ParadisDocDeliveryDecision =
	| { readonly kind: 'deliver'; readonly enter: boolean }
	| { readonly kind: 'wait'; readonly block: ParadisDocDeliveryBlock }
	| { readonly kind: 'undeliverable'; readonly block: ParadisDocDeliveryBlock };

/**
 * 届けてよいかを決める（note-tools-design.html の「届け方」の表）。
 * 許可待ち・質問待ち・作業中・書きかけがある間は、貼り付けも Enter も送らない。hook が一度も届いていないペインは
 * 状態を判断できないので届けない。入力欄の中身が分からないペインは、ターンの終わりの直後だけ入れる。
 */
export function paradisDecideDocDelivery(input: IParadisDocDeliveryInput): ParadisDocDeliveryDecision {
	switch (input.owner) {
		case 'none':
			return { kind: 'undeliverable', block: 'noOwner' };
		case 'ended':
			return { kind: 'undeliverable', block: 'ended' };
		case 'unknown':
			return { kind: 'undeliverable', block: 'unknown' };
		case 'waking':
			return { kind: 'wait', block: 'waking' };
	}
	if (!input.hasHooks) {
		return { kind: 'undeliverable', block: 'noHooks' };
	}
	if (input.status === 'permission' || input.status === 'question') {
		return { kind: 'wait', block: input.status };
	}
	if (input.starting === true) {
		return { kind: 'wait', block: 'waking' };
	}
	if (input.busy) {
		return { kind: 'wait', block: 'sending' };
	}
	if (input.status === 'working') {
		return { kind: 'wait', block: 'working' };
	}
	if (input.draft === 'text') {
		return { kind: 'wait', block: 'draft' };
	}
	if (input.draft === 'unknown' && !input.turnJustEnded && !input.forced) {
		return { kind: 'wait', block: 'draftUnknown' };
	}
	return { kind: 'deliver', enter: !input.remote && input.unconfirmedRelease === undefined };
}

/**
 * 貼った後、Enter の直前に確かめ直す。許可待ち・質問待ち・確かめられない解除・作業中なら送らない。
 * 入力欄に貼った文以外のものが入っていたら送らない（分からないときは貼った直後の画面の確認に任せる）。
 * 空のままなのは、入力欄の mod の知らせが貼った文にまだ追いついていないだけ（貼る前は空だったときだけ貼る）なので送る。
 */
export function paradisDocDeliveryMayEnter(status: ParadisAgentStatus | undefined, unconfirmedRelease: 'pending' | 'unverifiable' | undefined, draft: string | undefined, typed: string): boolean {
	if (status === 'permission' || status === 'question' || status === 'working' || unconfirmedRelease !== undefined) {
		return false;
	}
	return draft === undefined || draft.trim().length === 0 || draft.trim() === typed.trim();
}

// --- 終了した持ち主を起こす（Q663-4、Q667-7） ------------------------------------------------------

/** 再開のコマンドで起こせる CLI（SessionStart の hook で起きたペインを見つけられるもの）。 */
export type ParadisDocWakeAgent = 'claude' | 'codex';

/** ウィンドウへ渡す起こす券。会話 ID・CLI・作業ディレクトリは台帳から引く（ウィンドウの値を使わない）。 */
export interface IParadisDocWakeTicket {
	readonly kind: 'wake';
	readonly agent: ParadisDocWakeAgent;
	readonly session: string;
	/** 会話を始めた作業ディレクトリ（再開はここで行う。Claude Code はこのフォルダのプロジェクトから会話を探す）。 */
	readonly cwd: string;
}

/**
 * 起こさない理由。`noOwner` 持ち主がいない、`live` 持ち主の会話がどこかのペインで動いている、`unknown` 動いているか
 * 分からない（終了を見ていない）、`waking` もう起こしている途中、`maybeLive` 持ち主と確かめられない hook がその会話から
 * 届いている、`agent` 起こせない CLI、`remote` SSH 先の資料・SSH の窓、`noCwd` 会話を始めたフォルダが分からない。
 */
export type ParadisDocWakeRefusal = 'noOwner' | 'live' | 'unknown' | 'waking' | 'maybeLive' | 'agent' | 'remote' | 'noCwd';

export type ParadisDocWakeAnswer = IParadisDocWakeTicket | { readonly kind: 'refused'; readonly reason: ParadisDocWakeRefusal };

export interface IParadisDocWakeInput {
	readonly owner: { readonly agent: string; readonly session: string; readonly cwd?: string; readonly ended?: number } | undefined;
	/** 持ち主の会話が動いているペインがある。 */
	readonly live: boolean;
	/** その会話を起こしている途中。 */
	readonly waking: boolean;
	/** 持ち主と確かめられない hook がその会話から届いた。 */
	readonly seenUnverified: boolean;
	/** 資料の接続先の印（手元は空文字）。 */
	readonly hostId: string;
	/** 押したウィンドウが SSH の窓か。 */
	readonly windowIsRemote: boolean;
}

/**
 * 起こしてよいかを決める。生きている会話を再開すると会話が枝分かれするので、終了を見た会話だけを起こす。
 * 状態の分からない会話は、自動でも手動でも起こさない（note-tools-design.html の「届け方」の表）。
 */
export function paradisDecideDocWake(input: IParadisDocWakeInput): ParadisDocWakeAnswer {
	const owner = input.owner;
	const refuse = (reason: ParadisDocWakeRefusal): ParadisDocWakeAnswer => ({ kind: 'refused', reason });
	if (owner === undefined) {
		return refuse('noOwner');
	}
	if (input.live) {
		return refuse('live');
	}
	if (input.waking) {
		return refuse('waking');
	}
	if (owner.ended === undefined) {
		return refuse('unknown');
	}
	if (input.seenUnverified) {
		return refuse('maybeLive');
	}
	if (owner.agent !== 'claude' && owner.agent !== 'codex') {
		return refuse('agent');
	}
	if (input.hostId !== '' || input.windowIsRemote) {
		return refuse('remote');
	}
	if (owner.cwd === undefined) {
		return refuse('noCwd');
	}
	return { kind: 'wake', agent: owner.agent, session: owner.session, cwd: owner.cwd };
}

/**
 * 起こすスペース。作業ディレクトリを含むスペースのうち、いちばん深いもの（ワークツリーを本体より先に）。無ければ undefined。
 * スペースのフォルダは正規化した絶対パス（paradisNormalizeDocPath）で渡す。
 */
export function paradisDocWakeSpaceFor<T extends { readonly path: string }>(spaces: readonly T[], cwd: string): T | undefined {
	let best: T | undefined;
	for (const space of spaces) {
		if (paradisIsInsideFolder(cwd, space.path) && (best === undefined || space.path.length > best.path.length)) {
			best = space;
		}
	}
	return best;
}

// --- 貼る文 -----------------------------------------------------------------------------------

/** ユーザーの文を貼るときの上限（文字）。 */
export const PARADIS_DOC_DELIVERY_USER_TEXT_MAX = 200;

/** 1 行に均し、制御文字を除く。 */
function oneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** ユーザーの文の先頭 1 行（200 字まで）。 */
export function paradisDocDeliveryFirstLine(text: string): string {
	const first = text.split(/\r\n|\r|\n/).find(line => line.trim().length > 0) ?? '';
	const line = oneLine(first);
	return line.length > PARADIS_DOC_DELIVERY_USER_TEXT_MAX ? `${line.slice(0, PARADIS_DOC_DELIVERY_USER_TEXT_MAX - 1)}…` : line;
}

/**
 * ペインへ貼る 1 行。1 件なら ID とユーザーの文の先頭 1 行、2 件以上なら ID だけ。2 つのツール名を並べて書くのは、
 * Claude Code が遅延ロードのツールを 1 回の検索でまとめて読み込めるようにするため。
 */
export function paradisDocDeliveryText(fileName: string, comments: readonly { readonly id: string; readonly text: string }[]): string {
	const name = oneLine(fileName).slice(0, 200);
	if (comments.length === 1) {
		return oneLine(localize('paradis.docComments.delivery.one', "[Para Code 資料のコメント] {0} に 1 件（ID: {1}）: 「{2}」 para-browser の read_doc_comments で引用と位置を読み、対応したら reply_doc_comment で回答してください。", name, comments[0].id, paradisDocDeliveryFirstLine(comments[0].text)));
	}
	return oneLine(localize('paradis.docComments.delivery.many', "[Para Code 資料のコメント] {0} に {1} 件（ID: {2}）。para-browser の read_doc_comments で読み、1 件ずつ対応して reply_doc_comment で回答してください。", name, comments.length, comments.map(comment => comment.id).join(', ')));
}

/** UserPromptSubmit の prompt が、貼った文の届いたものか（ID が入っているか）。prompt が無ければ確かめられないので true。 */
export function paradisDocDeliveryPromptMatches(prompt: unknown, ids: readonly string[]): boolean {
	if (typeof prompt !== 'string') {
		return true;
	}
	return ids.some(id => prompt.includes(id));
}
