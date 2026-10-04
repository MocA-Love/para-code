/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisRedactMobileCommandOutput } from './paradisMobileOutputRedaction.js';

/**
 * モバイル通知の文言の組み立て（PC 側）。**通知の本文・詳細・副題の材料を決めるのはここだけ**。
 *
 * 並べ方（`mobile-notification-mock.html` の A1）:
 * - タイトル: スペース名（`paradisNotifyPresentation.ts` の `paradisNotifyTitle`。変えない）
 * - 副題: 受け取る側が組み立てる。PC が 2 台以上なら「エージェント · タブ名 · PC 名」、1 台ならタブ名だけ
 *   （何台とペアリングしているかは受け取る側しか知らないため。アプリは `app/mobile/src/notifyPresentation.ts`、
 *   通知拡張は `NotificationService.swift`）。PC は材料（`agent` と `tab`）を別々に送り、それを知らない旧アプリ・
 *   旧拡張のために従来の `subtitle` へ「エージェント · タブ名」を入れる
 * - 本文: 種類の言葉（「完了」「承認待ち」「質問」「エラー」）＋最後の発言・承認の中身・質問文。Markdown は外す
 * - 詳細（`detail`）: 長押しの画面（Notification Content Extension）が描く Markdown の原文
 *
 * 「通知に内容を含める」をオフにした端末には、本文を従来の定型文にし、詳細を付けない。
 * 文言は利用者の回答で変わりうるので、ここ以外に書かないこと。
 */

/** 通知の種類（iOS の通知のカテゴリ `para.<種類>` と対応する）。 */
export type ParadisNotifyCategory = 'done' | 'approval' | 'question' | 'error';

/** 本文の頭に付ける種類の言葉（記号は使わない。VoiceOver や通知の要約でもそのまま読めるように）。 */
const KIND_WORDS: Readonly<Record<ParadisNotifyCategory, string>> = {
	done: '完了',
	approval: '承認待ち',
	question: '質問',
	error: 'エラー',
};

/** 内容を含めないときの本文（従来の定型文。エラーは新しい種類なので新しい文）。 */
const FIXED_BODIES: Readonly<Record<ParadisNotifyCategory, string>> = {
	done: 'エージェントが作業を完了しました',
	approval: 'エージェントが確認を求めています',
	question: 'エージェントが質問しています',
	error: 'エージェントがエラーで止まりました',
};

/**
 * 本文の上限（文字）。プッシュはこのあと封緘後 3800B に収まるまで削る（`paradisFitNotifyForPush`）ので、
 * ここは E2E のフレーム（上限なし）でロック画面が持て余さない程度の歯止め。
 */
export const PARADIS_NOTIFY_BODY_MAX_CHARS = 1000;
/** 詳細（Markdown 原文）の上限（文字）。アプリが開いているときのローカル通知はこれを丸ごと持つ。 */
export const PARADIS_NOTIFY_DETAIL_MAX_CHARS = 6000;
/** 伏せ字の正規表現は長い文で遅くなるので、上限より少し多めに取った先頭だけを伏せる。 */
const REDACTION_MARGIN_CHARS = 200;
/** プッシュで詳細を残す最小の長さ。これより短くしか残せないなら詳細は付けず、長押しは本文を出す。 */
const DETAIL_MIN_CHARS = 200;
/** 詳細を優先する端末で、本文を削ってよい下限（ロック画面の 4 行に十分な長さ）。 */
const BODY_FLOOR_CHARS = 160;

// allow-any-unicode-next-line
const ELLIPSIS = '…';

/** 通知の材料。 */
export interface IParadisNotifyComposeInput {
	readonly category: ParadisNotifyCategory;
	/** 最後の発言・承認の中身・質問文（Markdown のまま）。無ければ定型文になる。 */
	readonly content?: string;
	/**
	 * 本文だけに使う短い Markdown（承認の「説明 + コマンドの先頭 1 行」）。無ければ `content` から本文を作る。
	 * 詳細（長押し）は常に `content`。
	 */
	readonly summary?: string;
	/** エラーの理由のコード（`usage_limit_exceeded` など。言い換えない）。 */
	readonly errorCode?: string;
	/** 「通知に内容を含める」。オフなら本文は定型文、詳細は付けない。 */
	readonly includeContent: boolean;
}

export interface IParadisNotifyComposed {
	readonly body: string;
	/** 長押しの画面に出す Markdown（内容を含めないとき・中身が無いときは undefined）。 */
	readonly detail?: string;
}

/** iOS の通知カテゴリの識別子（アプリの登録・通知拡張・Content Extension の Info.plist と一致させる）。 */
export function paradisNotifyCategoryId(category: ParadisNotifyCategory): string {
	return `para.${category}`;
}

/** 本文と詳細を組み立てる。 */
export function paradisComposeNotifyBody(input: IParadisNotifyComposeInput): IParadisNotifyComposed {
	const code = paradisNormalizeNotifyErrorCode(input.errorCode);
	const fixed = input.category === 'error' && code !== undefined ? `${FIXED_BODIES.error}（${code}）` : FIXED_BODIES[input.category];
	const raw = input.content?.trim();
	if (!input.includeContent || raw === undefined || raw.length === 0) {
		// エラーの理由のコードは中身ではないので、内容を含めない設定でも出す。
		return { body: fixed };
	}
	// 原文で伏せたあと、Markdown の装飾（`**` `__` バッククォート・表）に包まれて伏せ字の形に当たらなかった秘密を
	// 行ごとに伏せ直す（詳細）。本文は装飾を外した平文でもう一度伏せる。
	const redacted = paradisRedactMarkdownSecrets(paradisRedactNotifyText(raw, PARADIS_NOTIFY_DETAIL_MAX_CHARS));
	// 本文の材料が別にあれば（承認の「説明 + コマンドの先頭 1 行」）、同じ伏せ方をしてそちらを使う
	const summary = input.summary?.trim();
	const bodySource = summary !== undefined && summary.length > 0 ? paradisRedactMarkdownSecrets(paradisRedactNotifyText(summary, PARADIS_NOTIFY_DETAIL_MAX_CHARS)) : redacted;
	const plain = paradisRedactMobileCommandOutput(paradisStripMarkdownForNotify(bodySource)).trim();
	if (plain.length === 0) {
		return { body: fixed };
	}
	const lead = input.category === 'error' ? `${KIND_WORDS.error}: ${fixed}\n` : `${KIND_WORDS[input.category]}: `;
	const body = clampChars(`${lead}${plain}`, PARADIS_NOTIFY_BODY_MAX_CHARS);
	return { body, detail: redacted };
}

/**
 * 1 件の通知の、内容を含める版と含めない版を作る（`base` は本文と詳細以外の項目）。どちらをどのスマホへ送るかは
 * `paradisNotifyIncludeContent`（`paradisNotifyDelivery.ts`）が決める。含めない版は本文が定型文で、詳細を持たず、
 * 副題からタブ名も外す（タブ名にも作業の中身が出るため。Q177 A）。`agentLabel` は含めない版の副題に使う。
 */
export function paradisComposeNotifyVariants(base: Readonly<Record<string, unknown>>, input: Omit<IParadisNotifyComposeInput, 'includeContent'> & { readonly agentLabel?: string }): { readonly withContent: Record<string, unknown>; readonly withoutContent: Record<string, unknown> } {
	const { agentLabel, ...composeInput } = input;
	const build = (includeContent: boolean) => {
		const composed = paradisComposeNotifyBody({ ...composeInput, includeContent });
		const record: Record<string, unknown> = { ...base, body: composed.body };
		delete record.detail;
		if (composed.detail !== undefined) {
			record.detail = composed.detail;
		}
		if (!includeContent) {
			delete record.tab;
			delete record.subtitle;
			const subtitle = paradisLegacyNotifySubtitle(agentLabel, undefined);
			if (subtitle !== undefined) {
				record.subtitle = subtitle;
			}
		}
		return record;
	};
	return { withContent: build(true), withoutContent: build(false) };
}

/** 秘密らしい値を伏せてから上限で切る（切ってから伏せると、境目で切れた値の断片が伏せ字の形に当たらず残る）。 */
function paradisRedactNotifyText(text: string, maxChars: number): string {
	const redacted = paradisRedactMobileCommandOutput(text.slice(0, maxChars + REDACTION_MARGIN_CHARS)).trim();
	return clampChars(redacted, maxChars);
}

/**
 * Markdown の行の装飾を外した形で伏せ字を試し、伏せる値があった行だけ置き換える。`**password**: x`・
 * `` password: `x` ``・`| API_KEY | x |` のように、装飾が間に入って伏せ字の形に当たらない秘密を拾うため。
 * - 表の行: 隣り合うセルの組（「左: 右」）をすべて試し、伏せた組の右のセルだけを伏せ字にする。セルそのものに
 *   秘密の形があればそのセルも伏せる。表の形（区切りの `|`）は残す
 * - それ以外の行: 装飾を外した平文の伏せた形に置き換える（その行の装飾は失う）
 * コードブロックの区切りの行はそのまま残す。
 */
export function paradisRedactMarkdownSecrets(markdown: string): string {
	return markdown.split('\n').map(line => {
		if (/^\s*(?:```|~~~)/.test(line)) {
			return line;
		}
		const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/.exec(line)?.[0] ?? '';
		const content = line.slice(bullet.length).trim();
		if (/^\|.*\|$/.test(content)) {
			return paradisRedactTableRow(line, bullet, content);
		}
		const probe = paradisStripInlineMarkdown(content);
		const redacted = paradisRedactMobileCommandOutput(probe);
		return redacted === probe ? line : `${bullet}${redacted}`;
	}).join('\n');
}

/** 表の 1 行の伏せ字（{@link paradisRedactMarkdownSecrets}）。伏せる値が無ければ元の行を返す。 */
function paradisRedactTableRow(line: string, bullet: string, row: string): string {
	const cells = row.slice(1, -1).split('|').map(cell => cell.trim());
	const plain = cells.map(cell => paradisStripInlineMarkdown(cell));
	const hidden = cells.map(() => false);
	plain.forEach((cell, index) => {
		if (cell.length > 0 && paradisRedactMobileCommandOutput(cell) !== cell) {
			hidden[index] = true;
		}
		const next = plain[index + 1];
		if (next !== undefined && next.length > 0) {
			const pair = `${cell}: ${next}`;
			if (paradisRedactMobileCommandOutput(pair) !== pair) {
				hidden[index + 1] = true;
			}
		}
	});
	if (!hidden.some(Boolean)) {
		return line;
	}
	return `${bullet}| ${cells.map((cell, index) => hidden[index] ? '***' : cell).join(' | ')} |`;
}

function clampChars(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}${ELLIPSIS}` : text;
}

/** エラーの理由のコードとして出せる形（英数字と `_` `-` `.` `:` だけ、64 文字まで）。 */
export function paradisNormalizeNotifyErrorCode(value: unknown): string | undefined {
	return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
}

/**
 * Markdown を通知の本文（プレーンテキスト）へ直す。iOS の通知は装飾を描かないので、記号だけを外す。
 * - 見出し・引用・区切り線の記号を外す。箇条書きは「・」にする
 * - 強調・打ち消し・インラインコードの記号を外す。リンクと画像は文字だけ残す
 * - コードブロックは中身の 1 行目だけ残す（長いコードで本文の 4 行を使い切らないように）
 * - 表は「a / b」の 1 行にし、区切りの行は捨てる
 * - 空行は詰める
 */
export function paradisStripMarkdownForNotify(markdown: string): string {
	const out: string[] = [];
	let inFence = false;
	let fenceFirstLine = false;
	for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
		const fence = /^\s*(?:```|~~~)/.test(rawLine);
		if (fence) {
			inFence = !inFence;
			fenceFirstLine = inFence;
			continue;
		}
		if (inFence) {
			if (fenceFirstLine && rawLine.trim().length > 0) {
				out.push(rawLine.trim());
				fenceFirstLine = false;
			}
			continue;
		}
		let line = rawLine.trim();
		if (/^(?:[-*_]\s*){3,}$/.test(line) || /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) {
			continue; // 区切り線・表の区切りの行
		}
		line = line
			.replace(/^#{1,6}\s+/, '')
			.replace(/^(?:>\s?)+/, '')
			.replace(/^[-*+]\s+\[[ xX]\]\s+/, '・')
			.replace(/^[-*+]\s+/, '・');
		if (/^\|.*\|$/.test(line)) {
			line = line.slice(1, -1).split('|').map(cell => cell.trim()).filter(cell => cell.length > 0).join(' / ');
		}
		line = paradisStripInlineMarkdown(line);
		if (line.length > 0) {
			out.push(line);
		}
	}
	return out.join('\n').trim();
}

function paradisStripInlineMarkdown(line: string): string {
	return line
		.replace(/!\[(?<alt>[^\]]*)\]\([^)]*\)/g, '$<alt>')
		.replace(/\[(?<text>[^\]]+)\]\([^)]*\)/g, '$<text>')
		.replace(/`(?<code>[^`]+)`/g, '$<code>')
		.replace(/\*\*(?<text>[^*]+)\*\*/g, '$<text>')
		.replace(/__(?<text>[^_]+)__/g, '$<text>')
		.replace(/~~(?<text>[^~]+)~~/g, '$<text>')
		.replace(/(?<=^|[^\w*])\*(?<text>[^*\s][^*]*)\*(?=[^\w*]|$)/g, '$<text>')
		.trim();
}

/**
 * タブ名から、エージェントが端末タイトルの頭に出す印（Claude Code の ✳、作業中の点字のスピナーなど）を外す。
 * 外した結果が空・エージェント名そのもの・タイトル（スペース名）と同じなら出さない（同じ名前が 2 回並ぶため）。
 */
export function paradisNotifyTabLabel(tabTitle: string | undefined, agentLabel: string | undefined, title: string): string | undefined {
	const cleaned = tabTitle?.replace(/^[\p{S}\p{Z}\s]+/u, '').trim();
	if (cleaned === undefined || cleaned.length === 0 || cleaned === title) {
		return undefined;
	}
	if (agentLabel !== undefined && cleaned.toLowerCase() === agentLabel.toLowerCase()) {
		return undefined;
	}
	return cleaned.length > 100 ? cleaned.slice(0, 100) : cleaned;
}

/**
 * 旧アプリ・旧通知拡張向けの副題（`subtitle`）。旧い受け手はここへ 2 台以上のときだけ PC 名を足す。
 * 新しい受け手は `agent` と `tab` から組み立て直すので、これを読まない。
 */
export function paradisLegacyNotifySubtitle(agentLabel: string | undefined, tab: string | undefined): string | undefined {
	const parts = [agentLabel, tab].filter((part): part is string => part !== undefined && part.length > 0);
	return parts.length > 0 ? parts.join(' · ').slice(0, 100) : undefined;
}

/**
 * プッシュに入りきらない分を削る（封緘前の JSON を受け、削った JSON を返す）。
 *
 * `overflowBytes` は封緘前の UTF-8 で何バイト減らしたいか。削り方:
 * - `preferDetail`（長押しの画面を描ける新しいアプリ）: まず本文を {@link BODY_FLOOR_CHARS} 字まで削り、
 *   次に詳細を削る。詳細が {@link DETAIL_MIN_CHARS} 字を切るなら詳細は捨てて本文を戻す（長押しは本文を出す）
 * - そうでない端末: 詳細は読まれないので最初から捨て、本文だけを削る
 * これ以上削れない（本文が空）なら undefined。
 */
export function paradisFitNotifyForPush(record: Readonly<Record<string, unknown>>, overflowBytes: number, preferDetail: boolean): Record<string, unknown> | undefined {
	const body = typeof record.body === 'string' ? record.body : undefined;
	if (body === undefined) {
		return undefined;
	}
	const detail = preferDetail && typeof record.detail === 'string' ? record.detail : undefined;
	// 長さは JSON にしたときのバイト数で測る（改行・引用符は 2 バイト、制御文字は 6 バイトになる）。
	const bytes = paradisJsonStringBytes;
	const rest: Record<string, unknown> = { ...record };
	delete rest.detail;
	let need = overflowBytes - (detail === undefined && typeof record.detail === 'string' ? bytes(record.detail) + 12 : 0);
	if (need <= 0) {
		return rest;
	}
	if (detail !== undefined) {
		// 本文を下限まで削る。
		const bodyTarget = shrinkBy(body, need, BODY_FLOOR_CHARS);
		need -= bytes(body) - bytes(bodyTarget);
		if (need <= 0) {
			return { ...rest, body: bodyTarget, detail };
		}
		const detailTarget = shrinkBy(detail, need, 0);
		if (detailTarget.length >= DETAIL_MIN_CHARS) {
			return { ...rest, body: bodyTarget, detail: detailTarget };
		}
		// 詳細は残せない。捨てた分で本文を戻せるだけ戻す。
		return paradisFitNotifyForPush(rest, overflowBytes - bytes(detail) - 12, false);
	}
	if (body.length === 0) {
		return undefined;
	}
	const next = shrinkBy(body, need, 0);
	return next.length > 0 ? { ...rest, body: next } : undefined;
}

/** 1 文字（UTF-16 の 1 単位、サロゲートペア以外）を JSON の文字列に入れたときの UTF-8 のバイト数。 */
function paradisJsonCharBytes(code: number): number {
	if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
		return 2;
	}
	if (code < 0x20) {
		return 6;
	}
	return code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
}

/** 文字列を JSON の文字列に入れたときの UTF-8 のバイト数（前後の引用符を除く）。 */
function paradisJsonStringBytes(text: string): number {
	return new TextEncoder().encode(JSON.stringify(text)).length - 2;
}

/** 封緘で増えるバイト数（12B のノンス + 16B の認証タグ。`paradisMobileCrypto.ts` の `sealNotify`）。 */
const SEAL_OVERHEAD_BYTES = 28;

/** 封緘して base64url（詰め物なし）にしたときの長さ。リレーの上限（3800B）はこの長さで測る。 */
export function paradisSealedNotifyLength(plainBytes: number): number {
	return Math.ceil((plainBytes + SEAL_OVERHEAD_BYTES) * 4 / 3);
}

/**
 * 封緘前の通知（JSON のバイト列）を、封緘後に `limit` に収まるまで削る（本文と詳細だけを削り、片付けの印
 * `dismiss` など他の項目には触れない）。収まらない・JSON として読めないときは undefined。
 */
export function paradisFitNotifyBytesForPush(bytes: Uint8Array, limit: number, preferDetail: boolean): Uint8Array | undefined {
	let payload = bytes;
	// 削るたびに縮むので 2 回もあれば収まる。それでも駄目なら本文以外で埋まっている。
	for (let attempt = 0; attempt < 4; attempt++) {
		const sealedLength = paradisSealedNotifyLength(payload.length);
		if (sealedLength <= limit) {
			return payload;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(new TextDecoder().decode(payload));
		} catch {
			return undefined;
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return undefined;
		}
		// base64url は 3 バイトを 4 文字にするので、超えた文字数の 3/4 が生バイトでの不足分。端数のために少し多めに削る。
		const fitted = paradisFitNotifyForPush(parsed as Record<string, unknown>, Math.ceil((sealedLength - limit) * 0.75) + 16, preferDetail);
		if (fitted === undefined) {
			return undefined;
		}
		payload = new TextEncoder().encode(JSON.stringify(fitted));
	}
	return paradisSealedNotifyLength(payload.length) <= limit ? payload : undefined;
}

/** `text` を UTF-8 で `need` バイト以上短くする（`floorChars` 字より短くはしない）。削ったら末尾に「…」。 */
function shrinkBy(text: string, need: number, floorChars: number): string {
	if (need <= 0 || text.length <= floorChars) {
		return text;
	}
	// 「…」は 3 バイト。それも含めて足りるまで末尾から 1 字ずつ削る。数えるのは JSON にしたときのバイト数
	// （{@link paradisJsonCharBytes}。生の文字数で数えると、改行や引用符の多い文で足りずに詰め直しを繰り返し、丸ごと捨てる）。
	let length = text.length;
	let removed = 0;
	while (length > floorChars && removed < need + 3) {
		const code = text.charCodeAt(length - 1);
		if (code >= 0xdc00 && code <= 0xdfff && length >= 2) {
			length -= 2;
			removed += 4;
		} else {
			length -= 1;
			removed += paradisJsonCharBytes(code);
		}
	}
	if (length >= text.length) {
		return text;
	}
	const kept = text.slice(0, length).trimEnd();
	return kept.length > 0 ? `${kept}${ELLIPSIS}` : '';
}
