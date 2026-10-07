/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 内蔵ブラウザのフォーカスの移り変わりと、エージェントの入力の失敗を Sentry で読めるようにする判定の本体。
// Electron にも Sentry にも依存しない（main の配線は electron-main/paradisBrowserFocusDiagnosticsMain.ts）。
//
// 送るのは固定の語・回数・経過ミリ秒・ホスト名だけ。URL のパスやクエリ、ページの中身、入力した文字、
// 会話の本文は受け取りもしない（呼び出し側はホスト名に畳んだ値しか渡せない）。

/** Sentry の `safe_` 欄に載せる値。 */
export type ParadisBrowserDiagnosticData = Record<`safe_${string}`, string | number | boolean>;

/** 診断の送り先。テストでは記録するだけの偽物を渡す。 */
export interface IParadisBrowserDiagnosticsSink {
	breadcrumb(category: 'para.browser-focus' | 'para.browser-input', message: string, data: ParadisBrowserDiagnosticData): void;
	/** 1 件のイベント（captureMessage, warning）として送る。`tags` は `para.` で始まる絞り込み用の値。 */
	capture(operation: 'refocus-after-leave' | 'input-failure-summary', tags: Record<`para.${string}`, string>, data: ParadisBrowserDiagnosticData): void;
}

/** タイマーの差し替え口（テスト用）。 */
export interface IParadisBrowserDiagnosticsClock {
	now(): number;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultClock: IParadisBrowserDiagnosticsClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** フォーカスが入ったときの出どころ。 */
export type ParadisBrowserFocusOrigin =
	/** workbench の器が DOM focus を受け、tryFocus() が BrowserView.focus() を呼んだ。 */
	| 'para-code-container-focus'
	/** Para Code が BrowserView.focus() を呼んだ（tryFocus 以外: 検索バーを閉じたときなど）。 */
	| 'para-code-other'
	/** 利用者が BrowserView の上を押した。 */
	| 'user-pointer'
	/** エージェントの CDP 入力の直後。 */
	| 'agent-input'
	/** ウィンドウが前面に戻り、Chromium が前回のフォーカス先へ戻した。 */
	| 'window-activation'
	/** 上のどれにも当たらない＝ページ側（focus()・focus emulation 等）が取った。 */
	| 'page';

/** 直前の利用者のポインタ操作の場所。 */
export type ParadisBrowserPointerPlace = 'this-view' | 'other-view' | 'workbench' | 'none';

/** Para Code の focus() の呼び出しをフォーカスの出どころとみなす時間。 */
const FOCUS_REQUEST_WINDOW_MS = 300;
/** ポインタ・エージェント入力をフォーカスの出どころとみなす時間。 */
const POINTER_ORIGIN_WINDOW_MS = 1_000;
/** ウィンドウの前面化をフォーカスの出どころとみなす時間。 */
const WINDOW_ACTIVATION_WINDOW_MS = 300;
/** エージェントの入力の直後に来た BrowserView 上のポインタは、エージェントの入力の写しとみなす。 */
const AGENT_POINTER_ECHO_MS = 500;
/** 利用者が外へ移した、と言える「ポインタからフォーカスが外れるまで」の上限。 */
const LEAVE_POINTER_WINDOW_MS = 1_500;
/** 外へ移してからこの時間内に戻ったら異常として数える。 */
export const PARADIS_BROWSER_REFOCUS_WINDOW_MS = 3_000;
/** 同じタブで続いた戻りを 1 件にまとめる静かな時間。この間に次の戻りが無ければ送る。 */
const REFOCUS_EPISODE_QUIET_MS = 8_000;
/** 1 回の起動で送るフォーカスの異常の上限。 */
const MAX_REFOCUS_EVENTS_PER_RUN = 5;

/** パンくずの間引き: この窓の中でこの数まで。超えた分は数えて次の 1 件に載せる。 */
const BREADCRUMB_WINDOW_MS = 10_000;
const BREADCRUMB_MAX_PER_WINDOW = 6;

/** 失敗のまとめ: この件数か、最初の失敗からこの時間で 1 件にまとめて送る。 */
const FAILURE_SUMMARY_COUNT = 20;
const FAILURE_SUMMARY_DELAY_MS = 30 * 60 * 1_000;
/** 1 回の起動で送る失敗のまとめの上限。 */
const MAX_FAILURE_SUMMARIES_PER_RUN = 6;
/** まとめに載せる種類・ホストの数。 */
const SUMMARY_TOP_KINDS = 15;
const SUMMARY_TOP_HOSTS = 5;
/** 1 回のまとめの中で覚える種類・ホストの数（台帳が膨らまないように）。 */
const MAX_TRACKED_KEYS = 64;

const KNOWN_SCHEMES = new Set(['about', 'file', 'data', 'blob', 'chrome', 'devtools', 'chrome-extension']);
const PRIVATE_NAME_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.corp', '.intranet', '.localdomain', '.home.arpa'];
/**
 * 名前のまま送ってよい公開サイト。この登録ドメインの下のホスト（`docs.google.com` など）だけを
 * ホスト名のまま送り、ほかの公開ホストは `other-public` に畳む。公開の名前でも、トンネル
 * （`*.ngrok-free.app`）・プレビュー（`*.vercel.app`）・所属先（`<tenant>.atlassian.net`、
 * 公開 TLD 上の社内名）は利用者を明かすため。調べたいサイトが増えたらここへ足す。
 */
const KNOWN_PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
	'google.com', 'youtube.com', 'github.com', 'gitlab.com', 'microsoft.com', 'live.com', 'office.com',
	'apple.com', 'amazon.com', 'notion.so', 'figma.com', 'canva.com', 'stackoverflow.com', 'wikipedia.org',
	'x.com', 'twitter.com', 'openai.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'npmjs.com', 'example.com',
]);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_SHAPE = /^[a-z0-9.-]{1,253}$/;
const SAFE_WORD = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * URL をホスト名だけに畳む。パス・クエリ・ポート・利用者情報は捨てる。
 *
 * 社内の名前（`wiki.corp`・ドットの無い名前・`.local` 等）や IP アドレス・localhost は、
 * 名前そのものが利用者の環境を明かすので種類の語に置き換える。http(s) 以外は scheme の語だけ。
 */
export function paradisBrowserDiagnosticHost(url: string | undefined): string {
	if (!url) {
		return 'none';
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return 'invalid';
	}
	const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
	if (scheme !== 'http' && scheme !== 'https') {
		return KNOWN_SCHEMES.has(scheme) ? `scheme:${scheme}` : 'scheme:other';
	}
	const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
	if (host === 'localhost' || host.endsWith('.localhost')) {
		return 'localhost';
	}
	if (IPV4.test(host) || host.startsWith('[') || host.includes(':')) {
		return 'ip-address';
	}
	if (!host.includes('.')) {
		return 'single-label';
	}
	if (PRIVATE_NAME_SUFFIXES.some(suffix => host.endsWith(suffix))) {
		return 'private-name';
	}
	if (!HOST_SHAPE.test(host)) {
		return 'invalid';
	}
	const registrable = host.split('.').slice(-2).join('.');
	return KNOWN_PUBLIC_DOMAINS.has(registrable) ? host : 'other-public';
}

/** 固定の語だけを通す（ツール名・理由など。形が合わなければ `other`）。 */
function safeWord(value: string | undefined): string {
	return value !== undefined && SAFE_WORD.test(value) ? value : 'other';
}

/** 経過ミリ秒を Sentry に載せる形にする（無ければ -1、上限 10 分）。 */
function elapsed(now: number, at: number | undefined): number {
	if (at === undefined) {
		return -1;
	}
	return Math.min(Math.max(0, Math.round(now - at)), 600_000);
}

/** エージェント側の状態（共有プロセスのゲートウェイから届く）。 */
export interface IParadisBrowserAgentState {
	/** そのタブへのエージェントの CDP 接続の数。 */
	readonly connections?: number;
	/** `Emulation.setFocusEmulationEnabled` の最後の値。 */
	readonly focusEmulation?: boolean;
}

interface IRefocusEpisode {
	readonly startedAt: number;
	readonly firstElapsedMs: number;
	readonly host: string;
	count: number;
	lastAt: number;
	readonly origins: Map<ParadisBrowserFocusOrigin, number>;
	agentCdp: boolean;
	focusEmulation: boolean;
	timer: unknown;
}

interface IViewState {
	focused: boolean;
	lastFocusRequestAt?: number;
	lastFocusRequestOrigin?: 'container-focus' | 'other';
	lastAgentInputAt?: number;
	agentConnections: number;
	focusEmulation: boolean;
	/** 利用者がこのタブの外へフォーカスを移した時刻。次にフォーカスが入ったら消す。 */
	leftAt?: number;
	episode?: IRefocusEpisode;
}

interface IPointer {
	readonly view: object | undefined;
	readonly at: number;
}

/**
 * 内蔵ブラウザの診断の記録係。main に 1 つ。ビューは呼び出し側の任意のオブジェクトで識別する。
 */
export class ParadisBrowserDiagnosticsRecorder {

	private readonly views = new Map<object, IViewState>();
	/** 利用者の最後のポインタ操作。`view` が undefined なら workbench（ブラウザ以外）。 */
	private lastPointer: IPointer | undefined;
	private lastWindowActivationAt: number | undefined;
	private refocusEventsSent = 0;

	private breadcrumbWindowStartedAt = -Infinity;
	private breadcrumbsInWindow = 0;
	private droppedBreadcrumbs = 0;

	private failureCounts = new Map<string, number>();
	private failureHosts = new Map<string, number>();
	private keyAttemptsByHost = new Map<string, number>();
	private keyAttempts = 0;
	/** キー入力の準備が時間切れになったとき、返事をしなかったフレームの種類ごとの数。 */
	private keyUnansweredFrames = new Map<string, number>();
	private failures = 0;
	private failureWindowStartedAt: number | undefined;
	/** 前回のまとめ（無ければ起動）の時刻。キー入力の試行数はここから数えている。 */
	private lastFlushAt: number;
	private failureTimer: unknown;
	private failureSummariesSent = 0;

	constructor(
		private readonly sink: IParadisBrowserDiagnosticsSink,
		private readonly clock: IParadisBrowserDiagnosticsClock = defaultClock,
	) {
		this.lastFlushAt = clock.now();
	}

	// --- 入力の観測 ---

	/** 利用者がポインタを押した。`view` は押した BrowserView（workbench の別の場所なら undefined）。 */
	notePointer(view: object | undefined): void {
		const now = this.clock.now();
		if (view !== undefined) {
			const state = this.views.get(view);
			// CDP の Input.dispatchMouseEvent もビューの input-event に出る。直前に自分で送ったものは利用者の操作ではない。
			if (state?.lastAgentInputAt !== undefined && now - state.lastAgentInputAt <= AGENT_POINTER_ECHO_MS) {
				return;
			}
		}
		this.lastPointer = { view, at: now };
	}

	/** ウィンドウが前面に来た。 */
	noteWindowActivation(): void {
		this.lastWindowActivationAt = this.clock.now();
	}

	/** Para Code 自身が BrowserView.focus() を呼ぶ直前。 */
	noteFocusRequest(view: object, origin: 'container-focus' | 'other'): void {
		const state = this.state(view);
		state.lastFocusRequestAt = this.clock.now();
		state.lastFocusRequestOrigin = origin;
	}

	/** エージェントの CDP 入力をこのタブへ送る直前。 */
	noteAgentInput(view: object): void {
		this.state(view).lastAgentInputAt = this.clock.now();
	}

	/** エージェントの接続・focus emulation の変化。 */
	noteAgentState(view: object, change: IParadisBrowserAgentState): void {
		const state = this.state(view);
		if (change.connections !== undefined) {
			state.agentConnections = Math.max(0, Math.floor(change.connections));
			if (state.agentConnections === 0) {
				// 接続が全部切れたら Chromium 側の emulation も外れる。
				state.focusEmulation = false;
			}
		}
		if (change.focusEmulation !== undefined) {
			state.focusEmulation = change.focusEmulation;
		}
	}

	// --- フォーカス ---

	/** BrowserView のフォーカスが変わった。`host` は {@link paradisBrowserDiagnosticHost} で畳んだ値。 */
	focusChanged(view: object, focused: boolean, host: string): void {
		const state = this.state(view);
		if (state.focused === focused) {
			return;
		}
		state.focused = focused;
		const now = this.clock.now();
		const pointer = this.pointerFor(view);
		const common: ParadisBrowserDiagnosticData = {
			safe_host: host,
			safe_pointer_place: pointer.place,
			safe_since_pointer_ms: pointer.sinceMs,
			safe_agent_cdp: state.agentConnections > 0,
			safe_focus_emulation: state.focusEmulation,
		};
		if (!focused) {
			// 利用者が workbench か別のタブを押した直後に外れた＝利用者が外へ移した。
			const userLeft = pointer.place !== 'this-view' && pointer.place !== 'none' && pointer.sinceMs <= LEAVE_POINTER_WINDOW_MS;
			state.leftAt = userLeft ? now : undefined;
			// 普段の行き来はパンくずにしない（main のパンくず枠 100 件をほかの機能と分け合うため）。
			// 残すのは、利用者が外へ移した時（戻りの判定の起点）と、エージェントが繋いでいる間だけ。
			if (userLeft || state.agentConnections > 0) {
				this.addBreadcrumb('para.browser-focus', 'blur', { ...common, safe_user_left: userLeft });
			}
			return;
		}
		const origin = this.originFor(view, state, now);
		const leftAt = state.leftAt;
		state.leftAt = undefined;
		const returned = leftAt !== undefined && now - leftAt <= PARADIS_BROWSER_REFOCUS_WINDOW_MS && origin !== 'user-pointer';
		if (returned || leftAt !== undefined || state.agentConnections > 0) {
			this.addBreadcrumb('para.browser-focus', 'focus', {
				...common,
				safe_origin: origin,
				safe_since_leave_ms: elapsed(now, leftAt),
				safe_refocus: returned,
			});
		}
		if (origin === 'user-pointer' && state.episode) {
			// 利用者が自分で戻った。続いていた戻りはここで締める。
			this.finishEpisode(view, state);
		}
		if (returned) {
			this.recordRefocus(view, state, origin, now - leftAt, host, now);
		}
	}

	/** タブが閉じた。続いていた戻りを送り、台帳から外す。 */
	viewClosed(view: object): void {
		const state = this.views.get(view);
		if (!state) {
			return;
		}
		if (state.episode) {
			this.finishEpisode(view, state);
		}
		this.views.delete(view);
		if (this.lastPointer?.view === view) {
			this.lastPointer = undefined;
		}
	}

	private originFor(view: object, state: IViewState, now: number): ParadisBrowserFocusOrigin {
		if (state.lastFocusRequestAt !== undefined && now - state.lastFocusRequestAt <= FOCUS_REQUEST_WINDOW_MS) {
			return state.lastFocusRequestOrigin === 'container-focus' ? 'para-code-container-focus' : 'para-code-other';
		}
		if (this.lastPointer?.view === view && now - this.lastPointer.at <= POINTER_ORIGIN_WINDOW_MS) {
			return 'user-pointer';
		}
		if (state.lastAgentInputAt !== undefined && now - state.lastAgentInputAt <= POINTER_ORIGIN_WINDOW_MS) {
			return 'agent-input';
		}
		if (this.lastWindowActivationAt !== undefined && now - this.lastWindowActivationAt <= WINDOW_ACTIVATION_WINDOW_MS) {
			return 'window-activation';
		}
		return 'page';
	}

	private pointerFor(view: object): { readonly place: ParadisBrowserPointerPlace; readonly sinceMs: number } {
		const pointer = this.lastPointer;
		if (!pointer) {
			return { place: 'none', sinceMs: -1 };
		}
		const place: ParadisBrowserPointerPlace = pointer.view === undefined ? 'workbench' : pointer.view === view ? 'this-view' : 'other-view';
		return { place, sinceMs: elapsed(this.clock.now(), pointer.at) };
	}

	private recordRefocus(view: object, state: IViewState, origin: ParadisBrowserFocusOrigin, sinceLeaveMs: number, host: string, now: number): void {
		let episode = state.episode;
		if (!episode) {
			episode = {
				startedAt: now,
				firstElapsedMs: Math.round(sinceLeaveMs),
				host,
				count: 0,
				lastAt: now,
				origins: new Map(),
				agentCdp: false,
				focusEmulation: false,
				timer: undefined,
			};
			state.episode = episode;
		}
		episode.count++;
		episode.lastAt = now;
		episode.origins.set(origin, (episode.origins.get(origin) ?? 0) + 1);
		episode.agentCdp ||= state.agentConnections > 0;
		episode.focusEmulation ||= state.focusEmulation;
		if (episode.timer !== undefined) {
			this.clock.clearTimeout(episode.timer);
		}
		episode.timer = this.clock.setTimeout(() => {
			const current = this.views.get(view);
			if (current?.episode === episode) {
				this.finishEpisode(view, current);
			}
		}, REFOCUS_EPISODE_QUIET_MS);
	}

	private finishEpisode(_view: object, state: IViewState): void {
		const episode = state.episode;
		state.episode = undefined;
		if (!episode) {
			return;
		}
		if (episode.timer !== undefined) {
			this.clock.clearTimeout(episode.timer);
		}
		if (this.refocusEventsSent >= MAX_REFOCUS_EVENTS_PER_RUN) {
			return;
		}
		this.refocusEventsSent++;
		const origins = [...episode.origins].sort((a, b) => b[1] - a[1]);
		this.sink.capture('refocus-after-leave', {
			'para.area': 'browser-focus',
			'para.browser_host': episode.host,
			'para.focus_origin': origins[0]?.[0] ?? 'page',
			'para.focus_emulation': String(episode.focusEmulation),
			'para.agent_cdp': String(episode.agentCdp),
		}, {
			safe_host: episode.host,
			safe_returns: episode.count,
			safe_origins: origins.map(([origin, count]) => `${origin}=${count}`).join(','),
			safe_first_return_ms: episode.firstElapsedMs,
			safe_span_ms: Math.round(episode.lastAt - episode.startedAt),
			safe_agent_cdp: episode.agentCdp,
			safe_focus_emulation: episode.focusEmulation,
			safe_events_this_run: this.refocusEventsSent,
		});
	}

	// --- 入力の失敗 ---

	/** エージェントのキー入力の準備を始めた（失敗率の母数）。 */
	noteKeyAttempt(host: string): void {
		this.keyAttempts++;
		bump(this.keyAttemptsByHost, host);
	}

	/**
	 * キー入力の準備（抑止の登録・有効化）に失敗した。`reason` は #246 の理由の語。
	 * `unansweredFrames` は時間切れのとき返事をしなかったフレームの種類と数（`cross-origin=1,about-blank=2`。URL は含まない）。
	 */
	noteKeySuppressionFailure(host: string, phase: 'register' | 'activate', reason: string | undefined, unansweredFrames?: string): void {
		const safeReason = safeWord(reason ?? 'unknown');
		const data: ParadisBrowserDiagnosticData = { safe_host: host, safe_phase: phase, safe_reason: safeReason };
		const frames = parseFrameKinds(unansweredFrames);
		if (frames.length > 0) {
			data.safe_unanswered_frames = format(frames);
			for (const [kind, count] of frames) {
				const slot = this.keyUnansweredFrames.has(kind) || this.keyUnansweredFrames.size < MAX_TRACKED_KEYS ? kind : 'other';
				this.keyUnansweredFrames.set(slot, (this.keyUnansweredFrames.get(slot) ?? 0) + count);
			}
		}
		this.addBreadcrumb('para.browser-input', 'key-suppression-failed', data);
		this.recordFailure(`key-${phase}:${safeReason}`, host);
	}

	/** 入力キューの停止・再開・破棄・飽和。再開（settled）は失敗に数えない。 */
	noteInputQueue(host: string, kind: 'paused' | 'resumed' | 'abandoned' | 'saturated', cause: string | undefined, method: string | undefined): void {
		const data: ParadisBrowserDiagnosticData = { safe_host: host, safe_kind: kind };
		if (cause !== undefined) {
			data.safe_cause = safeWord(cause);
		}
		if (method !== undefined) {
			data.safe_method = safeWord(method);
		}
		this.addBreadcrumb('para.browser-input', `input-queue-${kind}`, data);
		if (kind !== 'resumed') {
			this.recordFailure(`queue-${kind}${cause !== undefined ? `:${safeWord(cause)}` : ''}`, host);
		}
	}

	/** para-browser のツールが失敗した。値はどれも固定の語（ツール名・エラーの種類・関所の理由）。 */
	noteToolFailure(host: string, tool: string, errorKind: string, gateReason: string | undefined): void {
		const data: ParadisBrowserDiagnosticData = { safe_host: host, safe_tool_name: safeWord(tool), safe_error_kind: safeWord(errorKind) };
		if (gateReason !== undefined) {
			data.safe_gate_reason = safeWord(gateReason);
		}
		this.addBreadcrumb('para.browser-input', 'tool-failed', data);
		this.recordFailure(`tool:${safeWord(tool)}:${safeWord(errorKind)}${gateReason !== undefined && gateReason !== 'none' ? `:${safeWord(gateReason)}` : ''}`, host);
	}

	private recordFailure(kind: string, host: string): void {
		this.failures++;
		bump(this.failureCounts, kind);
		bump(this.failureHosts, host);
		if (this.failureWindowStartedAt === undefined) {
			this.failureWindowStartedAt = this.clock.now();
			this.failureTimer = this.clock.setTimeout(() => this.flushFailures(), FAILURE_SUMMARY_DELAY_MS);
		}
		if (this.failures >= FAILURE_SUMMARY_COUNT) {
			this.flushFailures();
		}
	}

	/** たまった失敗を 1 件にまとめて送る（0 件なら何もしない）。 */
	flushFailures(): void {
		if (this.failureTimer !== undefined) {
			this.clock.clearTimeout(this.failureTimer);
			this.failureTimer = undefined;
		}
		const now = this.clock.now();
		const windowMs = Math.max(0, Math.round(now - this.lastFlushAt));
		this.lastFlushAt = now;
		const failures = this.failures;
		const counts = this.failureCounts;
		const hosts = this.failureHosts;
		const attemptsByHost = this.keyAttemptsByHost;
		const attempts = this.keyAttempts;
		const unansweredFrames = this.keyUnansweredFrames;
		this.keyUnansweredFrames = new Map();
		this.failures = 0;
		this.keyAttempts = 0;
		this.failureCounts = new Map();
		this.failureHosts = new Map();
		this.keyAttemptsByHost = new Map();
		this.failureWindowStartedAt = undefined;
		if (failures === 0 || this.failureSummariesSent >= MAX_FAILURE_SUMMARIES_PER_RUN) {
			return;
		}
		this.failureSummariesSent++;
		const topHost = top(hosts, 1)[0]?.[0] ?? 'none';
		const keyFailures = [...counts].filter(([kind]) => kind.startsWith('key-')).reduce((sum, [, count]) => sum + count, 0);
		this.sink.capture('input-failure-summary', {
			'para.area': 'browser-input',
			'para.browser_host': topHost,
		}, {
			safe_failures: failures,
			safe_kinds: format(top(counts, SUMMARY_TOP_KINDS)),
			safe_hosts: format(top(hosts, SUMMARY_TOP_HOSTS)),
			safe_key_attempts: attempts,
			safe_key_failures: keyFailures,
			safe_key_attempts_by_host: format(top(attemptsByHost, SUMMARY_TOP_HOSTS)),
			// 時間切れで返事をしなかったフレームの種類（同一 origin / 別 origin / about:blank / sandbox）と数。
			safe_key_unanswered_frames: format(top(unansweredFrames, SUMMARY_TOP_KINDS)),
			// キー入力の試行（母数）と失敗はどちらも前回のまとめから数えている。
			safe_window_ms: windowMs,
			safe_summaries_this_run: this.failureSummariesSent,
		});
	}

	// --- 共通 ---

	private addBreadcrumb(category: 'para.browser-focus' | 'para.browser-input', message: string, data: ParadisBrowserDiagnosticData): void {
		const now = this.clock.now();
		if (now - this.breadcrumbWindowStartedAt >= BREADCRUMB_WINDOW_MS) {
			this.breadcrumbWindowStartedAt = now;
			this.breadcrumbsInWindow = 0;
		}
		if (this.breadcrumbsInWindow >= BREADCRUMB_MAX_PER_WINDOW) {
			this.droppedBreadcrumbs++;
			return;
		}
		this.breadcrumbsInWindow++;
		const dropped = this.droppedBreadcrumbs;
		this.droppedBreadcrumbs = 0;
		this.sink.breadcrumb(category, message, dropped > 0 ? { ...data, safe_dropped_before: dropped } : data);
	}

	private state(view: object): IViewState {
		let state = this.views.get(view);
		if (!state) {
			state = { focused: false, agentConnections: 0, focusEmulation: false };
			this.views.set(view, state);
		}
		return state;
	}
}

/** `kind=n,kind=n` を読む。種類は固定の語に畳み、数は正の整数だけ受ける。 */
function parseFrameKinds(value: string | undefined): [string, number][] {
	if (value === undefined || value === '') {
		return [];
	}
	const result: [string, number][] = [];
	for (const part of value.split(',').slice(0, 8)) {
		const match = /^(?<kind>[a-z-]{1,24})=(?<count>\d{1,4})$/.exec(part);
		const count = match?.groups ? Number(match.groups.count) : 0;
		if (match?.groups && count > 0) {
			result.push([safeWord(match.groups.kind), count]);
		}
	}
	return result;
}

function bump(map: Map<string, number>, key: string): void {
	// 台帳が一杯なら、新しい語は `other` へ寄せる。
	const slot = map.has(key) || map.size < MAX_TRACKED_KEYS ? key : 'other';
	map.set(slot, (map.get(slot) ?? 0) + 1);
}

function top(map: Map<string, number>, limit: number): [string, number][] {
	return [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit);
}

function format(entries: readonly [string, number][]): string {
	return entries.map(([key, count]) => `${key}=${count}`).join(',');
}
