/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 会話ログ（Claude Code の transcript JSONL / Codex の rollout JSONL）の1行を、チャットの
// メッセージへ正規化する純粋な関数群。
//
// もとはモバイル中継（mobileRelay/node/paradisMobileAgentChat.ts）の中にあったものを、そのまま
// 切り出した（フェーズ6、デスクトップのチャット）。ファイルの読み取り（tail）と状態の追跡は
// 中継の TranscriptTailer に残し、ここは Node の API を使わない。**正規化の結果はそのままモバイルへ
// 送られる**ので、出力の形を変えるときはモバイル側の表示も確かめること。

import { IParadisAgentChatImage, IParadisAgentChatMessage, IParadisAgentQuestionOption } from './paradisAgentChat.js';
import { paradisRedactToolArgumentsText, paradisRedactToolInputSecrets } from '../../agentBrowser/common/paradisBrowserPageOps.js';

export { paradisQuestionReadyMarker } from './paradisAgentQuestionMarker.js';

export interface IParadisAgentActivityDetailMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool';
	readonly text: string;
	/**
	 * kind==='tool' のとき、呼び出しか結果か。モバイルはこれと toolUseId で
	 * 親のチャット画面と同じタイムライン（ツール名つきのステップ）を組み立てる。
	 */
	readonly toolKind?: 'tool_use' | 'tool_result';
	readonly tool?: string;
	readonly toolUseId?: string;
	readonly ts?: number;
	readonly isError?: boolean;
}

/** transcriptの生メッセージを SubAgent詳細用へ落とす（Claude / Codex 共通）。 */
export function toDetailMessage(message: IRawMessage): IParadisAgentActivityDetailMessage {
	const kind: IParadisAgentActivityDetailMessage['kind'] = message.kind === 'thinking' ? 'thinking' : message.kind === 'tool_use' || message.kind === 'tool_result' ? 'tool' : 'text';
	return {
		role: message.role, kind, text: message.text,
		...(message.kind === 'tool_use' || message.kind === 'tool_result' ? { toolKind: message.kind } : {}),
		...(message.tool !== undefined ? { tool: message.tool } : {}),
		...(message.toolUseId !== undefined ? { toolUseId: message.toolUseId } : {}),
		...(message.ts !== undefined ? { ts: message.ts } : {}),
		...(message.isError === true ? { isError: true } : {}),
	};
}


/** 本文テキストの上限 (モバイル表示用。超過は末尾に…を付けて切る)。 */
export const TEXT_LIMIT = 6000;
export const TOOL_TEXT_LIMIT = 1500;
/**
 * 'tool-full'（モバイルの展開時オンデマンド取得）で返せる全文の1件あたり上限。
 * 転送とPCメモリの両方を有界にするため、これを超える出力はここで打ち切る。
 */
export const FULL_TEXT_LIMIT = 64 * 1024;

/**
 * 'tool-image'（モバイルの展開時オンデマンド取得）で扱う画像1枚あたりの上限。
 * transcript には base64 のまま入っているため、その文字数で判定する（生バイトの約4/3 =
 * 生 2.2MB 程度まで）。MAX_TRANSCRIPT_LINE_BYTES より小さくしておくこと（それを超える行は
 * そもそも transcript から読めない）。超過した画像はメタに oversize を立てて実体を捨てる。
 */
export const TOOL_IMAGE_BASE64_LIMIT = 3 * 1024 * 1024;

/**
 * 1メッセージから拾う画像の枚数上限。'tool-image' 要求の index 上限（100未満）と揃える
 * （取り寄せられない画像のカードをモバイルに出さないため）。
 */
export const MAX_IMAGES_PER_MESSAGE = 100;

export function truncateText(text: string, limit: number): string {
	// allow-any-unicode-next-line
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * 表示用に切り詰めつつ、切り詰めたときだけ全文（FULL_TEXT_LIMIT まで）を添えて返す。
 * 全文は送信メッセージには載せず、tailer が rev 単位で保持してモバイルの
 * 'tool-full' リクエスト（展開時のオンデマンド取得）に応答するために使う。
 */
export function withTruncation(text: string, limit: number): { readonly text: string; readonly truncated?: true; readonly fullText?: string } {
	if (text.length <= limit) {
		return { text };
	}
	// allow-any-unicode-next-line
	return { text: `${text.slice(0, limit)}…`, truncated: true, fullText: text.slice(0, FULL_TEXT_LIMIT) };
}


// ---- transcript行 → 正規化メッセージ --------------------------------------------------------

export interface IRawMessage {
	readonly role: 'user' | 'assistant' | 'tool';
	readonly kind: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'question' | 'peer_message';
	readonly text: string;
	readonly tool?: string;
	readonly ts?: number;
	readonly header?: string;
	readonly options?: readonly IParadisAgentQuestionOption[];
	readonly multiSelect?: boolean;
	readonly toolUseId?: string;
	readonly questionGroup?: string;
	readonly questionIndex?: number;
	readonly questionCount?: number;
	readonly peerName?: string;
	readonly peerSummary?: string;
	readonly isError?: boolean;
	/** 切り詰め前の全文。モバイルへは送らず tailer が 'tool-full' 用に保持する。 */
	readonly fullText?: string;
	/** 画像の実体。モバイルへは送らず tailer が 'tool-image' 用に保持する。 */
	readonly imageData?: readonly IFlattenedImage[];
}

/**
 * 表示メッセージには乗らない「状態のためのシグナル」。パース時に1バッチ分を収集し、
 * tailer がバックグラウンドタスク・質問回答待ち・セッションメタ情報の追跡へ反映する。
 */
export type ICodexTranscriptActivityEvent =
	| { readonly type: 'turnStart'; readonly at: number }
	| { readonly type: 'subagent'; readonly id: string; readonly agentPath?: string; readonly kind: 'started' | 'interacted' | 'interrupted'; readonly at: number }
	| { readonly type: 'turnEnd'; readonly reason: 'completed' | 'failed' | 'interrupted'; readonly at: number };

export interface IParseSignals {
	/** バックグラウンドタスク（サブエージェント等）の起動: id → 起動時刻。 */
	readonly openedTasks: Map<string, number>;
	/** task-notification が届いた（完了・失敗・停止いずれも）タスクID。 */
	readonly closedTasks: string[];
	/** 出現した質問 (AskUserQuestion) の tool_use_id。 */
	readonly askedQuestionIds: string[];
	/** tool_result が現れた tool_use_id（質問の「回答済み」判定）。 */
	readonly answeredIds: string[];
	/** 実ユーザーのテキスト発話があった（未回答質問クリアの保険）。 */
	userText: boolean;
	/**
	 * ターンが終了した（Codex event_msg の task_complete / error / turn_aborted）。
	 * usage limit 等のエラー中断は Stop 系 hook が発火しないため、transcript が唯一の検出点。
	 * ライブ追記時のみライブ状態（考え中表示）の解除に使う。
	 */
	turnEnded: 'completed' | 'failed' | 'interrupted' | undefined;
	readonly codexActivityTimeline: ICodexTranscriptActivityEvent[];
	/**
	 * 直前に現れた Codex の view_image 呼び出しの call_id。
	 * Codex は読んだ画像の実体を「関数の結果」ではなく直後の user メッセージへ書くため、
	 * その画像をユーザーの発言ではなく view_image の結果として繋ぐのに使う。
	 */
	pendingCodexImageCallId?: string;
	model?: string;
	effort?: string;
	/**
	 * transcript の行が書かれた CLI のバージョン（Claude Code は各行に `version` を持つ）。
	 *
	 * 回答をTUIへ流すキー列は特定バージョンの実挙動に合わせてあるため（paradisAgentQuestionKeys の
	 * 冒頭を参照）、壊れたときに「どの版から変わったか」を切り分けられるようにこれだけ拾う。
	 */
	cliVersion?: string;
}

export function newParseSignals(): IParseSignals {
	return { openedTasks: new Map(), closedTasks: [], askedQuestionIds: [], answeredIds: [], codexActivityTimeline: [], userText: false, turnEnded: undefined };
}

export function decodeXmlAttribute(value: string): string {
	return value.replace(/&quot;/g, '"').replace(/&apos;/g, String.fromCodePoint(39)).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Claude Code Agent TeamsのMailbox配送を通常のユーザー発言から分離する。 */
export function parseClaudePeerMessage(rawText: string, ts: number | undefined): IRawMessage | null | undefined {
	// ユーザーがタグ文字列を質問に含めただけのケースを誤分類しないよう、Claude Codeが
	// 付ける配送prefixまたはcross-session wrapperが先頭にある場合だけ内部通信として扱う。
	if (!rawText.startsWith('Another Claude session sent a message') && !rawText.startsWith('<cross-session-message>')) {
		return undefined;
	}
	const tagged = /<(teammate-message|agent-message)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(rawText);
	if (tagged === null) {
		const crossSession = /<cross-session-message>([\s\S]*?)<\/cross-session-message>/.exec(rawText);
		const text = (crossSession?.[1] ?? rawText.replace(/^Another Claude session sent a message(?: while you were working)?:?\s*/, '')).trim();
		return text.length > 0 ? { role: 'assistant', kind: 'peer_message', text: truncateText(text, TEXT_LIMIT), ts } : null;
	}
	const attributes = tagged[2];
	const body = tagged[3].trim();
	try {
		const protocol = rec(JSON.parse(body));
		if (protocol?.type === 'idle_notification') {
			return null;
		}
	} catch {
		// 通常の自然言語レポートはJSONではない。
	}
	if (body.length === 0) {
		return null;
	}
	const name = /\b(?:teammate_id|from)="([^"]+)"/.exec(attributes)?.[1];
	const summary = /\bsummary="([^"]+)"/.exec(attributes)?.[1];
	return {
		role: 'assistant', kind: 'peer_message', text: truncateText(body, TEXT_LIMIT), ts,
		...(name !== undefined ? { peerName: decodeXmlAttribute(name) } : {}),
		...(summary !== undefined ? { peerSummary: decodeXmlAttribute(summary) } : {}),
	};
}

/** unknown からの安全なプロパティ読み出し。 */
export function rec(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function stableTextHash(value: string): string {
	let hash = 2166136261;
	for (const character of value) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}


export interface ITranscriptProgress {
	readonly tool: string;
	readonly detail?: string;
	readonly elapsedSeconds?: number;
	readonly done?: boolean;
}

/** Claude transcriptのephemeral progress行を、表示に必要な最小情報へ正規化する。 */
export function parseClaudeProgress(obj: Record<string, unknown>): ITranscriptProgress | undefined {
	if (obj.type !== 'progress') {
		return undefined;
	}
	const data = rec(obj.data);
	const type = str(data?.type);
	if (type === 'bash_progress') {
		const output = str(data?.output)?.trim();
		const detail = output?.split(/\r?\n/).filter(Boolean).at(-1);
		const elapsedSeconds = num(data?.elapsedTimeSeconds);
		return {
			tool: 'Bash',
			...(detail !== undefined ? { detail: truncateText(detail, 500) } : {}),
			...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
		};
	}
	if (type === 'mcp_progress') {
		const toolName = str(data?.toolName) ?? 'MCP';
		const serverName = str(data?.serverName);
		const progressMessage = str(data?.progressMessage);
		const status = str(data?.status);
		const elapsedTimeMs = num(data?.elapsedTimeMs);
		const detail = [serverName !== undefined ? `${serverName} MCP` : undefined, progressMessage].filter((part): part is string => part !== undefined && part.length > 0).join(' · ');
		return {
			tool: toolName,
			...(detail.length > 0 ? { detail: truncateText(detail, 500) } : {}),
			...(elapsedTimeMs !== undefined ? { elapsedSeconds: Math.max(0, Math.round(elapsedTimeMs / 1000)) } : {}),
			...((status === 'completed' || status === 'failed') ? { done: true } : {}),
		};
	}
	return undefined;
}

/**
 * 画像1枚のメタ情報（モバイルへ送る側）を作る。実体を保持できるかの判定も兼ねる:
 * transcript の1行上限を超える画像はそもそも読めないため、保持できる上限
 * （TOOL_IMAGE_BASE64_LIMIT）を超えたものは oversize として実体を捨てる。
 */
export function paradisToolImageMeta(index: number, image: { readonly mediaType: string; readonly base64: string }): IParadisAgentChatImage {
	// base64 の実バイト数（末尾パディングを除いた概算）。モバイルの容量表示にだけ使う。
	const padding = image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0;
	const bytes = Math.max(0, Math.floor(image.base64.length * 3 / 4) - padding);
	return {
		index, mediaType: image.mediaType, bytes,
		...(image.base64.length > TOOL_IMAGE_BASE64_LIMIT ? { oversize: true as const } : {}),
	};
}

/** tool_result の content に含まれていた画像1枚（実体つき）。 */
export interface IFlattenedImage {
	readonly mediaType: string;
	/** transcript に入っていた base64 そのまま。モバイルへは 'tool-image' でのみ渡す。 */
	readonly base64: string;
}

/** tool_result 等の content (string | ブロック配列) を表示テキストと画像へ分解した結果。 */
export interface IFlattenedContent {
	readonly text: string;
	readonly images: readonly IFlattenedImage[];
}

export function isImageMediaType(value: string): boolean {
	return /^image\/[a-zA-Z0-9.+-]{1,60}$/.test(value);
}

/**
 * 平坦化後の本文が画像のプレースホルダだけか（＝読める文が1つも無いか）。
 * 画像ブロックは `[image]` の行として残るため、本文の有無はこれで判定する。
 */
export function isImagePlaceholderOnly(text: string): boolean {
	return text.split('\n').every(line => {
		const trimmed = line.trim();
		return trimmed.length === 0 || trimmed === '[image]';
	});
}

/**
 * Codex が rollout に書く画像は data URI 形式（`data:image/png;base64,...`）。
 * 想定外の形（外部URL・base64以外のエンコード）は取り込まない。
 */
export function parseImageDataUri(value: string | undefined): IFlattenedImage | undefined {
	if (value === undefined) {
		return undefined;
	}
	const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
	const mediaType = match?.[1];
	const base64 = match?.[2];
	if (mediaType === undefined || base64 === undefined || base64.length === 0 || !isImageMediaType(mediaType)) {
		return undefined;
	}
	return { mediaType, base64 };
}

/** tool_result 等の content (string | ブロック配列) を表示テキストへ平坦化する。 */
export function flattenContent(content: unknown): string {
	return flattenContentParts(content).text;
}

/**
 * flattenContent の画像つき版。画像ブロックは表示テキストでは従来どおり `[image]` の
 * プレースホルダにしつつ（この行しか読めない旧モバイルのため）、実体を別に取り出す。
 */
export function flattenContentParts(content: unknown): IFlattenedContent {
	if (typeof content === 'string') {
		return { text: content, images: [] };
	}
	if (Array.isArray(content)) {
		const parts: string[] = [];
		const images: IFlattenedImage[] = [];
		for (const block of content) {
			const b = rec(block);
			if (!b) {
				continue;
			}
			const text = str(b.text);
			if (text !== undefined) {
				parts.push(text);
			} else if (b.type === 'image') {
				// Claude: { type:'image', source:{ type:'base64', media_type, data } }
				parts.push('[image]');
				const source = rec(b.source);
				const base64 = str(source?.data);
				const mediaType = str(source?.media_type);
				if (str(source?.type) === 'base64' && base64 !== undefined && base64.length > 0 && mediaType !== undefined && isImageMediaType(mediaType)) {
					images.push({ mediaType, base64 });
				}
			} else if (b.type === 'input_image') {
				// Codex: { type:'input_image', image_url:'data:image/png;base64,...' }
				parts.push('[image]');
				const image = parseImageDataUri(str(b.image_url));
				if (image !== undefined) {
					images.push(image);
				}
			}
		}
		return { text: parts.join('\n'), images };
	}
	return { text: '', images: [] };
}

/**
 * AskUserQuestion の input（{ questions: [{ question, header, options: [{label, description}] , multiSelect? }] }）を
 * question メッセージ列へ展開する。想定形でなければ空配列（呼び出し側が汎用 tool_use にフォールバック）。
 */
export function parseAskUserQuestions(input: unknown, toolUseId: string | undefined, ts: number | undefined): IRawMessage[] {
	const inputRec = rec(input);
	const questionsRaw = inputRec?.questions;
	if (!Array.isArray(questionsRaw)) {
		return [];
	}
	const out: IRawMessage[] = [];
	for (const questionRaw of questionsRaw) {
		const q = rec(questionRaw);
		const questionText = str(q?.question);
		if (!q || questionText === undefined || questionText.trim().length === 0) {
			continue;
		}
		const options: IParadisAgentQuestionOption[] = [];
		const optionsRaw = q.options;
		if (Array.isArray(optionsRaw)) {
			for (const optionRaw of optionsRaw) {
				const o = rec(optionRaw);
				const label = str(o?.label);
				if (label !== undefined && label.trim().length > 0) {
					const description = str(o?.description);
					options.push({ label: truncateText(label, 200), ...(description !== undefined ? { description: truncateText(description, 500) } : {}) });
				}
			}
		}
		out.push({
			role: 'assistant', kind: 'question', text: truncateText(questionText, TEXT_LIMIT), ts,
			...(str(q.header) !== undefined ? { header: str(q.header) } : {}),
			...(options.length > 0 ? { options } : {}),
			...(q.multiSelect === true ? { multiSelect: true } : {}),
			...(toolUseId !== undefined ? { toolUseId } : {}),
		});
	}
	// 同一呼び出しの複数質問はモバイル側で1枚のステップ式カードへ集約するため、グループメタを
	// 付与する（グループキーは transcript 経路では実 toolUseId。ライブ注入経路では toolUseId が
	// 無いため injectLiveQuestions 側で合成キーを設定する）。
	return out.map((message, index) => ({
		...message,
		questionIndex: index,
		questionCount: out.length,
		...(toolUseId !== undefined ? { questionGroup: toolUseId } : {}),
	}));
}

/**
 * ライブ質問（hook注入）と transcript 上の本物の質問を突き合わせるための内容キー。
 * 両者とも parseAskUserQuestions を通るため、truncate 後のテキストが一致する。
 */
export function liveQuestionContentKey(m: Pick<IRawMessage, 'text' | 'options'>): string {
	return `${m.text}\0${(m.options ?? []).map(o => o.label).join('\x01')}`;
}

/**
 * transcript に現れた質問に対応する注入済みライブ質問の合成IDを台帳から取り出す。
 * まず内容キー（質問文+選択肢ラベル列）の完全一致で引き、外れた場合は質問文のみの
 * 第2段マッチへフォールバックする。第2段は hook 側/transcript 側の一方で選択肢が
 * 欠落した場合（Windows の PowerShell hook が tool_input の深い配列を落とす等）の救済で、
 * 同文の別質問を誤って間引かないよう、候補が1エントリに絞れるときだけ適用する。
 * 内容キーは `text + '\0' + labels` 形式のため、`text + '\0'` の前方一致 = 質問文の完全一致。
 */
export function paradisTakeLiveQuestionSyntheticId(liveQuestions: Map<string, string[]>, message: Pick<IRawMessage, 'text' | 'options'>): string | undefined {
	let key = liveQuestionContentKey(message);
	let ids = liveQuestions.get(key);
	if (ids === undefined || ids.length === 0) {
		// 選択肢欠落は「一方の options が空」の形でしか起きないため、第2段は
		// 「incoming が選択肢なし、または台帳側エントリが選択肢なし（キーが text+'\0' のみ）」
		// に限定する。両側に異なる選択肢が付いた同文の質問は別物として素通しする
		// （誤 dedup で実在質問を隠し、回答を別質問へ誤紐付けするのを防ぐ）。
		const textPrefix = `${message.text}\0`;
		const incomingHasNoOptions = (message.options ?? []).length === 0;
		const candidates = [...liveQuestions.entries()].filter(([entryKey, entryIds]) =>
			entryIds.length > 0 && entryKey.startsWith(textPrefix) && (incomingHasNoOptions || entryKey === textPrefix));
		if (candidates.length !== 1) {
			return undefined;
		}
		[key, ids] = candidates[0];
	}
	const syntheticId = ids.shift();
	if (syntheticId !== undefined && ids.length === 0) {
		liveQuestions.delete(key);
	}
	return syntheticId;
}

/**
 * メッセージ列に未回答のまま残っている同内容の質問があるかを返す。突き合わせは内容キーの
 * 完全一致に加え、どちらかの選択肢が欠落しているケースを質問文のみでも拾う
 * （前方一致は `'\0'` 区切りのため質問文の完全一致と等価）。回答済みの同文質問とは衝突しない。
 */
export function paradisHasPendingDuplicateQuestion(
	messages: readonly Pick<IParadisAgentChatMessage, 'kind' | 'text' | 'options' | 'toolUseId'>[],
	pendingQuestions: ReadonlySet<string>,
	message: Pick<IRawMessage, 'text' | 'options'>,
): boolean {
	const contentKey = liveQuestionContentKey(message);
	const textPrefix = `${message.text}\0`;
	const incomingHasNoOptions = (message.options ?? []).length === 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		const existing = messages[index];
		if (existing.kind !== 'question' || existing.toolUseId === undefined || !pendingQuestions.has(existing.toolUseId)) {
			continue;
		}
		const existingKey = liveQuestionContentKey(existing);
		if (existingKey === contentKey) {
			return true;
		}
		// 質問文のみの一致は「どちらかの選択肢が欠落している」場合に限る
		// （take 側と同じ理由: 同文・異選択肢の別質問を誤って抑制しない）
		const existingHasNoOptions = (existing.options ?? []).length === 0;
		if ((incomingHasNoOptions && existingKey.startsWith(textPrefix))
			|| (existingHasNoOptions && contentKey.startsWith(`${existing.text}\0`))) {
			return true;
		}
	}
	return false;
}

/**
 * Claude Code のユーザーロール行のテキストを表示メッセージへ変換する。
 * ハーネスが user ロールとして注入する合成テキスト（バックグラウンドタスクの完了通知・
 * スラッシュコマンドの実行記録・system-reminder 等）は「ユーザーの発言」として
 * 吹き出し表示すると誤解を招くため、種類ごとに変換・除去する。
 */
export function pushClaudeUserText(out: IRawMessage[], rawText: string, ts: number | undefined, signals: IParseSignals): void {
	const trimmed = rawText.trim();
	if (trimmed.length === 0) {
		return;
	}
	const peerMessage = parseClaudePeerMessage(trimmed, ts);
	if (peerMessage !== undefined) {
		if (peerMessage !== null) {
			out.push(peerMessage);
		}
		return;
	}
	// ユーザーがescでツール実行（AskUserQuestion等）を中断した際にハーネスが注入する
	// 内部マーカー。ユーザーの発言ではないため表示しない（signals.userTextも立てない。
	// 立てると同一バッチ内の未回答質問カードを誤ってクリアしてしまう）。
	if (/^\[Request interrupted by user( for tool use)?\]$/.test(trimmed)) {
		return;
	}
	// バックグラウンドタスク（サブエージェント等）の完了通知。ユーザーの発言ではなく
	// ハーネスからの通知なので、ツール結果カードとして表示する。
	if (trimmed.startsWith('<task-notification>')) {
		for (const match of trimmed.matchAll(/<task-id>([^<\n]+)<\/task-id>/g)) {
			signals.closedTasks.push(match[1].trim());
		}
		const summary = /<summary>([\s\S]*?)<\/summary>/.exec(trimmed)?.[1]?.trim();
		const result = /<result>([\s\S]*?)<\/result>/.exec(trimmed)?.[1]?.trim();
		const status = /<status>([^<\n]+)<\/status>/.exec(trimmed)?.[1]?.trim();
		// allow-any-unicode-next-line
		const title = summary !== undefined && summary.length > 0 ? `バックグラウンドタスク完了: ${summary}` : 'バックグラウンドタスクが完了しました';
		const parts = [title];
		if (status !== undefined && status !== 'completed') {
			parts.push(`status: ${status}`);
		}
		if (result !== undefined && result.length > 0) {
			parts.push(result);
		}
		out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(parts.join('\n'), TOOL_TEXT_LIMIT), ts });
		return;
	}
	// スラッシュコマンドの実行記録（/compact 等）。コマンド名だけを短く出す。
	const commandName = /<command-name>([^<\n]*)<\/command-name>/.exec(trimmed)?.[1]?.trim();
	if (commandName !== undefined && commandName.length > 0) {
		const commandArgs = /<command-args>([^<\n]*)<\/command-args>/.exec(trimmed)?.[1]?.trim();
		out.push({ role: 'user', kind: 'text', text: truncateText(commandArgs ? `${commandName} ${commandArgs}` : commandName, TEXT_LIMIT), ts });
		return;
	}
	// ローカルコマンドの出力・注意書きはノイズなので出さない。ただし /effort の実行記録は
	// セッションの effort 変更としてメタ情報へ反映する（Claude の transcript に effort の
	// 直接の記録は無く、これと settings.json の既定値だけが手掛かり）。
	if (trimmed.startsWith('<local-command-stdout>') || trimmed.startsWith('<local-command-caveat>')) {
		const effortMatch = /^<local-command-stdout>Set effort level to (\w+)/.exec(trimmed);
		if (effortMatch) {
			signals.effort = effortMatch[1];
		}
		return;
	}
	// 本文へ付随する system-reminder（メモリ想起等のハーネス注入）は表示から除く。
	const text = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
	if (text.length === 0) {
		return;
	}
	signals.userText = true;
	out.push({ role: 'user', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
}

/** Claude Code transcript JSONL の1行をパースする。表示対象外の行は空配列。 */
export function parseClaudeLine(obj: Record<string, unknown>, signals: IParseSignals, includeSidechain = false): IRawMessage[] {
	if ((!includeSidechain && obj.isSidechain === true) || obj.isMeta === true) {
		return []; // サブエージェント内・メタ行はメインの会話に出さない
	}
	// 表示対象かどうかに関わらず拾う（どの行にも入っており、最後に見た値が今動いている版）。
	const version = str(obj.version);
	if (version !== undefined) {
		signals.cliVersion = version;
	}
	const type = str(obj.type);
	if (type === 'attachment') {
		// 作業中に届いたバックグラウンドタスクの完了通知は、ユーザーの発言ではなく `queued_command` の
		// attachment として書かれる（実データで通知の約4分の1）。表示はしないが、実行中のタスクは閉じる。
		const attachment = rec(obj.attachment);
		const prompt = attachment?.type === 'queued_command' ? str(attachment.prompt) : undefined;
		if (prompt?.trimStart().startsWith('<task-notification>')) {
			for (const match of prompt.matchAll(/<task-id>([^<\n]+)<\/task-id>/g)) {
				signals.closedTasks.push(match[1].trim());
			}
		}
		return [];
	}
	if (type !== 'user' && type !== 'assistant') {
		return []; // summary / system / file-history-snapshot 等
	}
	const message = rec(obj.message);
	if (!message) {
		return [];
	}
	const tsRaw = str(obj.timestamp);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const out: IRawMessage[] = [];
	const content = message.content;

	if (type === 'user') {
		if (typeof content === 'string') {
			pushClaudeUserText(out, content, ts, signals);
			return out;
		}
		if (Array.isArray(content)) {
			// ユーザーが貼った画像は tool_result ではなく content 直下に image ブロックとして入る。
			// 本文と同じ発言の一部なので、テキスト側のメッセージへまとめて添える。
			const pastedImages: IFlattenedImage[] = [];
			for (const block of content) {
				const b = rec(block);
				if (!b) {
					continue;
				}
				if (b.type === 'text') {
					pushClaudeUserText(out, str(b.text) ?? '', ts, signals);
				} else if (b.type === 'image') {
					const image = flattenContentParts([b]).images[0];
					if (image !== undefined) {
						pastedImages.push(image);
					}
				} else if (b.type === 'tool_result') {
					const { text, images } = flattenContentParts(b.content);
					// toolUseId は質問(AskUserQuestion)の「回答済み」判定に使う（本文が空でも回答は成立する）。
					const toolUseId = str(b.tool_use_id);
					if (toolUseId !== undefined) {
						signals.answeredIds.push(toolUseId);
					}
					// バックグラウンドタスク（サブエージェント等）の起動応答から実行中タスクを学習する。
					if (/Async agent launched|running in the background/i.test(text)) {
						const idMatch = /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text) ?? /background with ID:\s*([A-Za-z0-9_-]+)/.exec(text);
						if (idMatch) {
							signals.openedTasks.set(idMatch[1], ts ?? Date.now());
						}
					}
					if (text.trim().length > 0 || images.length > 0) {
						out.push({
							role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts,
							...(toolUseId !== undefined ? { toolUseId } : {}),
							// transcript の is_error。モバイルは失敗ステップを赤で示す（推定に頼らない）。
							...(b.is_error === true ? { isError: true } : {}),
							...(images.length > 0 ? { imageData: images } : {}),
						});
					}
				}
			}
			if (pastedImages.length > 0) {
				// 直前のユーザー発言に添える。画像だけを貼った（本文なし）ときは
				// 画像だけの発言として1件作る。
				const last = out.at(-1);
				if (last?.role === 'user' && last.kind === 'text' && last.imageData === undefined) {
					out[out.length - 1] = { ...last, imageData: pastedImages };
				} else {
					signals.userText = true;
					out.push({ role: 'user', kind: 'text', text: '', ts, imageData: pastedImages });
				}
			}
		}
		return out;
	}

	// assistant
	const model = str(message.model);
	if (model !== undefined && model.length > 0) {
		signals.model = model;
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			const b = rec(block);
			if (!b) {
				continue;
			}
			if (b.type === 'text') {
				const text = str(b.text) ?? '';
				if (text.trim().length > 0) {
					out.push({ role: 'assistant', kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
				}
			} else if (b.type === 'thinking') {
				const text = str(b.thinking) ?? '';
				if (text.trim().length > 0) {
					out.push({ role: 'assistant', kind: 'thinking', ...withTruncation(text, TOOL_TEXT_LIMIT), ts });
				}
			} else if (b.type === 'tool_use') {
				const rawTool = str(b.name) ?? 'tool';
				const tool = rawTool === 'WebSearch' ? 'web_search' : rawTool;
				const toolUseId = str(b.id);
				// AskUserQuestion はユーザーへの選択式質問。汎用ツールとして折りたたむと
				// モバイルで質問に気づけないため、専用の question メッセージに展開する。
				if (tool === 'AskUserQuestion') {
					const questions = parseAskUserQuestions(b.input, toolUseId, ts);
					if (questions.length > 0) {
						if (toolUseId !== undefined) {
							signals.askedQuestionIds.push(toolUseId);
						}
						out.push(...questions);
						continue;
					}
					// input が想定形でない場合は従来どおり汎用 tool_use として出す
				}
				let text = '';
				const input = rec(b.input);
				if (tool === 'Agent' || tool === 'Task') {
					// サブエージェント起動は description（何をさせるか）を出す方が JSON より分かりやすい。
					const description = str(input?.description);
					const subagentType = str(input?.subagent_type);
					if (description !== undefined && description.length > 0) {
						text = subagentType !== undefined && subagentType.length > 0 ? `${description} (${subagentType})` : description;
					}
				}
				if (tool === 'web_search') {
					// クエリ文字列をそのまま出す（JSON のままだとモバイルの検索カードで読みにくい）。
					text = str(input?.query) ?? '';
				}
				if (text.length === 0) {
					try {
						// 資格情報（set_http_credentials の password）は画面へ出さない
						text = JSON.stringify(paradisRedactToolInputSecrets(rawTool, b.input));
					} catch { /* 表示は空でよい */ }
				}
				out.push({ role: 'assistant', kind: 'tool_use', tool, ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(toolUseId !== undefined ? { toolUseId } : {}) });
			}
		}
	}
	return out;
}

/** transcript分類の回帰テスト用。productionと同じparserを1行だけ通す。 */
export function paradisParseClaudeTranscriptLineForTest(line: string): { messages: IRawMessage[]; userText: boolean } {
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(line));
	} catch {
		return { messages: [], userText: false };
	}
	if (obj === undefined) {
		return { messages: [], userText: false };
	}
	const signals = newParseSignals();
	const messages = JSON.parse(JSON.stringify(parseClaudeLine(obj, signals))) as IRawMessage[];
	return { messages, userText: signals.userText };
}

/** Codex transcript分類の回帰テスト用。productionと同じparserを1行だけ通す。 */
export function paradisParseCodexTranscriptLineForTest(line: string): { messages: IRawMessage[]; activity?: Omit<Extract<ICodexTranscriptActivityEvent, { type: 'subagent' }>, 'type'>; turn?: 'started' | 'ended' } {
	let obj: Record<string, unknown> | undefined;
	try {
		obj = rec(JSON.parse(line));
	} catch {
		return { messages: [] };
	}
	if (obj === undefined) {
		return { messages: [] };
	}
	const signals = newParseSignals();
	const messages = JSON.parse(JSON.stringify(parseCodexLine(obj, signals))) as IRawMessage[];
	const activity = signals.codexActivityTimeline.find((event): event is Extract<ICodexTranscriptActivityEvent, { type: 'subagent' }> => event.type === 'subagent');
	const turn = signals.codexActivityTimeline.find(event => event.type === 'turnStart' || event.type === 'turnEnd');
	return { messages, ...(activity !== undefined ? { activity: { id: activity.id, ...(activity.agentPath !== undefined ? { agentPath: activity.agentPath } : {}), kind: activity.kind, at: activity.at } } : {}), ...(turn !== undefined ? { turn: turn.type === 'turnStart' ? 'started' : 'ended' } : {}) };
}

/**
 * 連続する Codex rollout 行を1つの signals で通す（view_image のように、呼び出しと
 * 画像の実体が別の行に分かれる並びを検証するため）。
 */
export function paradisParseCodexTranscriptLinesForTest(lines: readonly string[]): IRawMessage[] {
	const signals = newParseSignals();
	const out: IRawMessage[] = [];
	for (const line of lines) {
		let obj: Record<string, unknown> | undefined;
		try {
			obj = rec(JSON.parse(line));
		} catch {
			continue;
		}
		if (obj !== undefined) {
			out.push(...parseCodexLine(obj, signals));
		}
	}
	return JSON.parse(JSON.stringify(out)) as IRawMessage[];
}

/** Codex子threadのrollout行を、SubAgent詳細用メッセージへ正規化する。 */
export function paradisParseCodexDetailLinesForTest(lines: readonly string[]): IParadisAgentActivityDetailMessage[] {
	const out: IParadisAgentActivityDetailMessage[] = [];
	for (const line of lines) {
		let parsed: Record<string, unknown> | undefined;
		try { parsed = rec(JSON.parse(line)); } catch { continue; }
		if (parsed === undefined) { continue; }
		for (const message of parseCodexLine(parsed, newParseSignals())) {
			if (message.kind === 'question' || message.kind === 'peer_message') { continue; }
			out.push(toDetailMessage(message));
		}
	}
	return out.slice(-200);
}

/** Codex rollout JSONL の1行をパースする。表示対象外の行は空配列。 */
export function parseCodexLine(obj: Record<string, unknown>, signals: IParseSignals): IRawMessage[] {
	// rollout行: { timestamp, type, payload }
	if (obj.type === 'turn_context') {
		// ターンごとの実行コンテキスト（model / effort 等）。表示メッセージは無いがメタ情報を学習する。
		const context = rec(obj.payload);
		const model = str(context?.model);
		const effort = str(context?.effort);
		if (model !== undefined && model.length > 0) {
			signals.model = model;
		}
		if (effort !== undefined && effort.length > 0) {
			signals.effort = effort;
		}
		return [];
	}
	if (obj.type === 'event_msg') {
		// event_msg は表示内容には使わず、SubAgent活動とターン終了の状態復元に使う。
		// usage limit（error / codex_error_info: usage_limit_exceeded）や
		// 中断（turn_aborted）は hooks.json に対応イベントが無く Stop hook が発火しないため、
		// ここで拾わないと「考え中」表示が永久に残る。
		const eventPayload = rec(obj.payload);
		const eventType = str(eventPayload?.type);
		if (eventType === 'sub_agent_activity') {
			const id = str(eventPayload?.agent_thread_id);
			const kind = str(eventPayload?.kind);
			const timestamp = str(obj.timestamp);
			const at = num(eventPayload?.occurred_at_ms) ?? (timestamp !== undefined ? Date.parse(timestamp) : NaN);
			if (id !== undefined && (kind === 'started' || kind === 'interacted' || kind === 'interrupted') && Number.isFinite(at)) {
				signals.codexActivityTimeline.push({ type: 'subagent', id, ...(str(eventPayload?.agent_path) !== undefined ? { agentPath: str(eventPayload?.agent_path) } : {}), kind, at });
			}
		}
		if (eventType === 'task_started') {
			const timestamp = str(obj.timestamp);
			const at = timestamp !== undefined ? Date.parse(timestamp) : NaN;
			if (Number.isFinite(at)) { signals.codexActivityTimeline.push({ type: 'turnStart', at }); }
		}
		if (eventType === 'task_complete' || eventType === 'error' || eventType === 'turn_aborted') {
			signals.turnEnded = eventType === 'task_complete' ? 'completed' : eventType === 'turn_aborted' ? 'interrupted' : 'failed';
			const timestamp = str(obj.timestamp);
			const at = timestamp !== undefined ? Date.parse(timestamp) : NaN;
			if (Number.isFinite(at)) { signals.codexActivityTimeline.push({ type: 'turnEnd', reason: signals.turnEnded, at }); }
		}
		return [];
	}
	if (obj.type !== 'response_item') {
		return []; // session_meta 等も対象外
	}
	const payload = rec(obj.payload);
	if (!payload) {
		return [];
	}
	const tsRaw = str(obj.timestamp);
	const tsParsed = tsRaw !== undefined ? Date.parse(tsRaw) : NaN;
	const ts = Number.isFinite(tsParsed) ? tsParsed : undefined;
	const ptype = str(payload.type);
	// Codex のツール呼び出し/結果は call_id で対応付く (Claude の tool_use_id 相当)。
	// toolUseId に載せてモバイル側で呼び出し⇔結果の突き合わせに使えるようにする
	// (質問の回答済み判定は kind==='question' 限定なので Codex の ID が混ざっても影響しない)。
	let callId = str(payload.call_id) ?? str(payload.id);
	const out: IRawMessage[] = [];

	if (ptype === 'message') {
		const role = str(payload.role);
		if (role !== 'user' && role !== 'assistant') {
			return []; // developer / system プロンプトは出さない
		}
		const { text, images } = flattenContentParts(payload.content);
		// Codexはuserメッセージとして環境コンテキスト/プロジェクト指示を注入するため表示から除く。
		// 旧CLI(0.4x): <environment_context> / <user_instructions>
		// 新CLI(0.80+): 「# AGENTS.md instructions for <path>」見出し＋<INSTRUCTIONS>ラッパー
		const trimmedText = text.trim();
		// 中断の知らせ（`<turn_aborted>The user interrupted the previous turn on purpose…`、codex-cli 0.155.1）も
		// ユーザーの発言ではないので出さない。
		if (/^<(environment_context|user_instructions|ENVIRONMENT_CONTEXT|INSTRUCTIONS|turn_aborted)/.test(trimmedText)
			|| trimmedText.startsWith('# AGENTS.md instructions for')) {
			return [];
		}
		// view_image の実体が来るのは「直後の」メッセージだけなので、ここで必ず手放す。
		// 持ち越すと、実体が来ないまま後で貼られた無関係な画像がその呼び出しの結果として
		// 繋がってしまう（環境コンテキストの注入は上で弾いた後なので巻き込まれない）。
		const pendingImageCallId = signals.pendingCodexImageCallId;
		signals.pendingCodexImageCallId = undefined;
		if (images.length > 0) {
			// Codex は view_image の実体を「関数の結果」ではなく直後の user メッセージへ
			// input_image として書く。本文のない画像だけのメッセージがそれで、ユーザーの発言
			// ではなく直前の view_image の結果なので、ツール結果として繋ぐ（signals が覚えた
			// call_id を使う）。本文つき = ユーザーが貼った画像はそのまま発言として出す。
			const viewImageCallId = isImagePlaceholderOnly(trimmedText) ? pendingImageCallId : undefined;
			if (viewImageCallId !== undefined) {
				out.push({
					role: 'tool', kind: 'tool_result', text: truncateText(text, TOOL_TEXT_LIMIT), ts,
					toolUseId: viewImageCallId, imageData: images,
				});
				return out;
			}
			out.push({ role, kind: 'text', text: truncateText(text, TEXT_LIMIT), ts, imageData: images });
			return out;
		}
		if (trimmedText.length === 0) {
			return [];
		}
		out.push({ role, kind: 'text', text: truncateText(text, TEXT_LIMIT), ts });
	} else if (ptype === 'reasoning') {
		const text = flattenContent(payload.summary);
		if (text.trim().length > 0) {
			out.push({ role: 'assistant', kind: 'thinking', ...withTruncation(text, TOOL_TEXT_LIMIT), ts });
		}
	} else if (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'mcp_tool_call') {
		// custom_tool_call は arguments でなく input にテキストが入る（それ以外は function_call と同形）
		const tool = str(payload.name) ?? 'tool';
		// 資格情報（set_http_credentials の password）は画面へ出さない
		const text = paradisRedactToolArgumentsText(tool, str(payload.arguments) ?? str(payload.input) ?? '');
		if (tool === 'view_image') {
			// 実体は直後の user メッセージへ書かれる。その画像をこの呼び出しへ繋ぐため覚えておく。
			signals.pendingCodexImageCallId = callId;
		}
		out.push({ role: 'assistant', kind: 'tool_use', tool, ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'web_search_call' || ptype === 'tool_search_call') {
		// web_search_call は action.query、tool_search_call は arguments(オブジェクト)にクエリが入る
		const action = rec(payload.action);
		const args = rec(payload.arguments);
		let query = str(action?.query) ?? str(args?.query) ?? '';
		if (ptype === 'web_search_call' && action !== undefined) {
			try {
				const actionText = JSON.stringify(action);
				if (/https?:\/\//i.test(actionText) && !query.includes(actionText)) { query = [query, actionText].filter(Boolean).join('\n'); }
			} catch { /* 表示はqueryだけでよい */ }
		}
		if (query.length === 0) {
			try {
				query = JSON.stringify(args ?? action ?? '');
			} catch { /* 表示は空でよい */ }
		}
		if (ptype === 'web_search_call' && callId === undefined && tsRaw !== undefined) {
			callId = `web:${tsRaw}:${stableTextHash(query)}`;
		}
		out.push({ role: 'assistant', kind: 'tool_use', tool: ptype === 'web_search_call' ? 'web_search' : 'tool_search', ...withTruncation(query, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		if (ptype === 'web_search_call' && (payload.status === 'completed' || payload.status === 'failed')) {
			const resultText = payload.status === 'failed' ? `Web検索に失敗しました${query ? `\n${query}` : ''}` : query || 'Web検索完了';
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(resultText, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}), ...(payload.status === 'failed' ? { isError: true } : {}) });
		}
	} else if (ptype === 'tool_search_output') {
		// tool_search_call の結果 ({ call_id, status, execution, tools: [...] })。見つかった
		// ツール一覧を結果カードとして出す (無視するとツール検索の結果だけ同期から抜ける)。
		const toolsRaw = payload.tools;
		let text = '';
		if (Array.isArray(toolsRaw) && toolsRaw.length > 0) {
			try {
				text = toolsRaw.map(tool => {
					const t = rec(tool);
					return str(t?.name) ?? JSON.stringify(tool);
				}).join('\n');
			} catch { /* 表示は空でよい */ }
		}
		if (text.trim().length === 0) {
			text = str(payload.status) ?? '';
		}
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	} else if (ptype === 'custom_tool_call_output') {
		const text = str(payload.output) ?? '';
		if (text.trim().length > 0) {
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
		}
	} else if (ptype === 'local_shell_call') {
		let text = '';
		try {
			text = JSON.stringify(payload.action);
		} catch { /* 表示は空でよい */ }
		out.push({ role: 'assistant', kind: 'tool_use', tool: 'shell', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}) });
	} else if (ptype === 'function_call_output') {
		const output = payload.output;
		let text: string;
		let failed = false;
		if (typeof output === 'string') {
			text = output;
		} else {
			const o = rec(output);
			text = str(o?.content) ?? flattenContent(output) ?? '';
			// Codex は成否を output.success / metadata.exit_code で示す（形は実装依存なので取れた方だけ見る）。
			const exitCode = rec(o?.metadata)?.exit_code;
			failed = o?.success === false || (typeof exitCode === 'number' && exitCode !== 0);
			if (!text) {
				try {
					text = JSON.stringify(output);
				} catch {
					text = '';
				}
			}
		}
		// view_image は結果本文を持たず（"attached local image path" とだけ書く）、実体は直後の
		// user メッセージに来る。この定型文を出すと画像カードと同じ枠が二重に並ぶので落とす。
		const isViewImagePlaceholder = callId !== undefined && callId === signals.pendingCodexImageCallId && text.trim() === 'attached local image path';
		if (text.trim().length > 0 && !isViewImagePlaceholder) {
			out.push({ role: 'tool', kind: 'tool_result', ...withTruncation(text, TOOL_TEXT_LIMIT), ts, ...(callId !== undefined ? { toolUseId: callId } : {}), ...(failed ? { isError: true } : {}) });
		}
	}
	return out;
}
