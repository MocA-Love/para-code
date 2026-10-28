// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Codex の非同期の質問（agent.async-questions.v1）の、この端末だけの状態: 問いごとの書きかけ、送った印、「答えずに閉じる」。
 * 閉じた問いは `secureKeyStore` に保存して、アプリを再起動しても戻さない（件数は {@link DISMISSED_LIMIT} まで）。
 */

import { create } from 'zustand';
import type { AsyncAnswerDraft, AsyncQuestion } from './asyncQuestions.js';
import { secureKeyStore } from './platform.js';

/** 送ってからこの時間のうちに PC の一覧から消えなければ、「送った」の印を外してもう一度答えられるようにする。 */
const SENT_HOLD_MS = 60_000;
/** 「答えずに閉じる」を覚えておく問いの数（古いものから捨てる）。 */
export const DISMISSED_LIMIT = 200;
const DISMISSED_STORAGE_KEY = 'asyncQuestionDismissed';

/**
 * 送った印。`at` は PC に届いた（受け付けられた）時刻で、そこから {@link SENT_HOLD_MS} だけ隠す。`queuedText` は、PC に
 * つながっていない間に預けた返信の本文で、預かりの一覧に残っている間は時間に関わらず隠す（届く前にもう一度答えさせない）。
 */
export interface AsyncSentMark {
	readonly at: number;
	readonly queuedText?: string;
}

/** 閉じた問いを覚える（最後に閉じたものを末尾へ。上限を超えたら古いものから捨てる）。 */
export function withDismissed(dismissed: readonly string[], ids: readonly string[], limit = DISMISSED_LIMIT): string[] {
	const added = new Set(ids);
	const next = [...dismissed.filter(id => !added.has(id)), ...ids];
	return next.slice(Math.max(0, next.length - limit));
}

/** 保存されていた閉じた問いを読む。形の崩れたものは捨てる。 */
export function parseDismissed(raw: string | null): string[] {
	if (raw === null) {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 300).slice(-DISMISSED_LIMIT) : [];
	} catch {
		return [];
	}
}

/** 閉じた問いを覚える鍵（短い形。questionItemId の JSON ではなく `call_id:番号`）。 */
export function dismissKey(question: Pick<AsyncQuestion, 'callId' | 'index'>): string {
	return `${question.callId}:${question.index}`;
}

type PaneRecord<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

interface AsyncQuestionDraftStore {
	/** ペイン（terminalKey）→ questionItemId → 書きかけ。ペインごとに分けて持ち、掃除もペインごとにする。 */
	readonly drafts: PaneRecord<AsyncAnswerDraft>;
	/** ペイン → questionItemId → 送った印（PC の一覧から消えるまで、もう一度は送らせない）。 */
	readonly sent: PaneRecord<AsyncSentMark>;
	/** この端末で「答えずに閉じる」を押した問い（{@link dismissKey}。PC には知らせない。端末に保存して、再起動しても戻さない）。 */
	readonly dismissed: readonly string[];
	setDraft(pane: string, id: string, draft: AsyncAnswerDraft | undefined): void;
	/** 送った。`queuedText` は PC に届くまで預けた返信の本文。 */
	markSent(pane: string, ids: readonly string[], queuedText?: string): void;
	/** 預けた返信が預かりの一覧から無くなった（届いた・消した）。そこから {@link SENT_HOLD_MS} の間だけ隠す。 */
	settleQueued(queuedTexts: ReadonlySet<string>, now: number): void;
	dismiss(questions: readonly Pick<AsyncQuestion, 'callId' | 'index'>[]): void;
	/** 保存済みの閉じた問いを読む（最初に使う画面が呼ぶ。2 回目以降は何もしない）。 */
	load(): void;
	/** そのペインで PC の一覧に無くなった問いの書きかけ・印を捨てる（`known` はそのペインの今の一覧の問い）。 */
	prune(pane: string, known: readonly string[]): void;
}

let dismissedLoadStarted = false;
let dismissedLoaded = false;

function saveDismissed(dismissed: readonly string[]): void {
	secureKeyStore.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(dismissed)).catch((err: unknown) => console.warn('[asyncQuestions] failed to save the dismissed questions', err));
}

/** ペインの記録の 1 件を書き換える（`value` が undefined なら消す。空になったペインは消す）。 */
function withPaneValue<T>(record: PaneRecord<T>, pane: string, id: string, value: T | undefined): PaneRecord<T> {
	const { [id]: _previous, ...rest } = record[pane] ?? {};
	const next = value === undefined ? rest : { ...rest, [id]: value };
	const { [pane]: _pane, ...others } = record;
	return Object.keys(next).length > 0 ? { ...others, [pane]: next } : others;
}

export const useAsyncQuestionDrafts = create<AsyncQuestionDraftStore>((set, get) => ({
	drafts: {},
	sent: {},
	dismissed: [],
	setDraft(pane, id, draft) {
		set({ drafts: withPaneValue(get().drafts, pane, id, draft) });
	},
	markSent(pane, ids, queuedText) {
		const now = Date.now();
		const mark: AsyncSentMark = queuedText !== undefined ? { at: now, queuedText } : { at: now };
		set({ sent: ids.reduce((record, id) => withPaneValue(record, pane, id, mark), get().sent) });
	},
	settleQueued(queuedTexts, now) {
		let changed = false;
		const next: Record<string, Record<string, AsyncSentMark>> = {};
		for (const [pane, marks] of Object.entries(get().sent)) {
			next[pane] = {};
			for (const [id, mark] of Object.entries(marks)) {
				if (mark.queuedText !== undefined && !queuedTexts.has(mark.queuedText)) {
					next[pane][id] = { at: now };
					changed = true;
				} else {
					next[pane][id] = mark;
				}
			}
		}
		if (changed) {
			set({ sent: next });
		}
	},
	dismiss(questions) {
		const next = withDismissed(get().dismissed, questions.map(dismissKey));
		set({ dismissed: next });
		// 読み込む前に書くと、保存されていた分を消してしまう。読み込んだあとで重ねて書く
		if (dismissedLoaded) {
			saveDismissed(next);
		} else {
			get().load();
		}
	},
	load() {
		if (dismissedLoadStarted) {
			return;
		}
		dismissedLoadStarted = true;
		secureKeyStore.getItem(DISMISSED_STORAGE_KEY).then(raw => {
			const current = get().dismissed;
			const merged = withDismissed(parseDismissed(raw), current);
			dismissedLoaded = true;
			set({ dismissed: merged });
			if (current.length > 0) {
				saveDismissed(merged);
			}
		}).catch((err: unknown) => {
			// 端末のロック中などで読めなかった。次に画面を開いたときにもう一度読む
			dismissedLoadStarted = false;
			console.warn('[asyncQuestions] failed to load the dismissed questions', err);
		});
	},
	prune(pane, known) {
		const keep = new Set(known);
		const state = get();
		const pick = <T,>(record: PaneRecord<T>): PaneRecord<T> | undefined => {
			const current = record[pane];
			if (current === undefined) {
				return undefined;
			}
			const kept = Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id)));
			if (Object.keys(kept).length === Object.keys(current).length) {
				return undefined;
			}
			const { [pane]: _pane, ...others } = record;
			return Object.keys(kept).length > 0 ? { ...others, [pane]: kept } : others;
		};
		const drafts = pick(state.drafts);
		const sent = pick(state.sent);
		if (drafts !== undefined || sent !== undefined) {
			set({ ...(drafts !== undefined ? { drafts } : {}), ...(sent !== undefined ? { sent } : {}) });
		}
	},
}));

/** その問いを今カードに出さないか（預けた返信が届いていない・送ってから間もない・この端末で閉じた）。`sent` はそのペインの印。 */
export function isAsyncQuestionHidden(state: { readonly sent: Readonly<Record<string, AsyncSentMark>> | undefined; readonly dismissed: readonly string[] }, question: AsyncQuestion, now: number): boolean {
	const mark = state.sent?.[question.id];
	return state.dismissed.includes(dismissKey(question)) || (mark !== undefined && (mark.queuedText !== undefined || now - mark.at < SENT_HOLD_MS));
}
