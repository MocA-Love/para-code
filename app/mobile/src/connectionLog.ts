// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { RelayConnectionEvent } from './relayClient.js';

/**
 * 接続の記録（W2-22。設定 →「接続の記録」。Orca の connection-log-buffer.ts / connection-log-redaction.ts に倣った）。
 *
 * つながらないとき、利用者に見えるのは「接続中」「再接続」だけで、切断の理由は Sentry にしか残らなかった。
 * PC ごとに直近 200 件の出来事（接続・切断と close code・再接続までの待ち・資格の拒否・回線の変化）を
 * 伏せ字にしてから端末へ残し、画面で読めるようにする。報告はクリップボードへのコピーだけ（Q118 A）。
 *
 * **ここに入るのは出来事の種類・数値・伏せ字にした OS のエラー文だけ。** トークン・URL・識別子は
 * 呼び出し側が渡さない前提だが、エラー文に紛れ込む分はここで伏せる。
 */

/** アプリ側（RelayClient の外）で起きる出来事。 */
export interface AppConnectionEvent {
	readonly kind: 'network-change' | 'grace-requested' | 'grace-held' | 'grace-refused' | 'grace-ended';
	readonly detail?: string;
}

export type ConnectionLogEventInput = RelayConnectionEvent | AppConnectionEvent;

export type ConnectionLogEntry = ConnectionLogEventInput & { readonly at: number };

/** PC ごとに残す件数。 */
export const CONNECTION_LOG_LIMIT = 200;
const DETAIL_MAX_LENGTH = 160;

/**
 * OS のエラー文から秘密になりうるものを伏せる。URL（クエリにトークンが載りうる）、スキームの無いホスト名
 * （自前のリレーの場所）、長い英数字（トークン・識別子・鍵。mobileId は 22 文字）、16進の並び、IP アドレス、
 * メールアドレス。
 */
export function redactConnectionDetail(text: string): string {
	return text
		.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
		.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
		.replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
		.replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, '<host>')
		.replace(/[A-Za-z0-9_-]{20,}/g, '<id>')
		.replace(/\b[0-9a-fA-F]{12,}\b/g, '<hex>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, DETAIL_MAX_LENGTH);
}

/** 保存する形へ整える（伏せ字・数値の検証）。 */
export function normalizeConnectionEntry(event: ConnectionLogEventInput, at: number): ConnectionLogEntry {
	const detail = event.detail !== undefined ? redactConnectionDetail(event.detail) : undefined;
	const numeric = (value: number | undefined) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);
	const source = event as RelayConnectionEvent;
	const code = numeric(source.code);
	const delayMs = numeric(source.delayMs);
	const attempt = numeric(source.attempt);
	return {
		kind: event.kind,
		at,
		...(code !== undefined ? { code } : {}),
		...(delayMs !== undefined ? { delayMs } : {}),
		...(attempt !== undefined ? { attempt } : {}),
		...(typeof source.online === 'boolean' ? { online: source.online } : {}),
		...(detail !== undefined && detail.length > 0 ? { detail } : {}),
	} as ConnectionLogEntry;
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
	'connecting', 'online', 'closed', 'connect-timeout', 'socket-error', 'auth-rejected', 'reconnect-scheduled', 'suspended', 'resumed', 'pc-presence', 'pc-restarted',
	'network-change', 'grace-requested', 'grace-held', 'grace-refused', 'grace-ended',
]);

/** ファイルから読んだ記録を検証する（壊れた項目は捨てる）。 */
export function parseConnectionLog(raw: string | null): ConnectionLogEntry[] {
	if (raw === null) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const entries: ConnectionLogEntry[] = [];
	for (const item of parsed.slice(-CONNECTION_LOG_LIMIT)) {
		if (item === null || typeof item !== 'object') {
			continue;
		}
		const record = item as Record<string, unknown>;
		if (typeof record.kind !== 'string' || !KNOWN_KINDS.has(record.kind) || typeof record.at !== 'number' || !Number.isFinite(record.at)) {
			continue;
		}
		entries.push(normalizeConnectionEntry({
			kind: record.kind,
			...(typeof record.code === 'number' ? { code: record.code } : {}),
			...(typeof record.delayMs === 'number' ? { delayMs: record.delayMs } : {}),
			...(typeof record.attempt === 'number' ? { attempt: record.attempt } : {}),
			...(typeof record.online === 'boolean' ? { online: record.online } : {}),
			...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
		} as ConnectionLogEventInput, record.at));
	}
	return entries;
}

/** 記録の置き場（実体は `connectionLogStore.ts` のアプリ sandbox 内ファイル）。 */
export interface ConnectionLogStorage {
	read(pcId: string): Promise<string | null>;
	write(pcId: string, text: string): Promise<void>;
	remove(pcId: string): Promise<void>;
}

/**
 * PC ごとの記録の本体。追記はメモリへ入れてすぐ返し、ファイルへはまとめて書く
 * （同じ瞬間に続けて起きる出来事、例えば「切断 → 再接続の予約」を1回の書き込みにする）。
 */
export class ConnectionLogBook {
	private readonly entries = new Map<string, ConnectionLogEntry[]>();
	private readonly dirty = new Set<string>();
	private readonly loaded = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private writeChain: Promise<void> = Promise.resolve();
	private version = 0;

	constructor(
		private readonly storage: ConnectionLogStorage,
		private readonly now: () => number = Date.now,
		private readonly flushDelayMs = 500,
	) { }

	/** 起動時に保存分を読む。読むより前に追記された分は後ろへ続ける。 */
	async load(pcId: string): Promise<void> {
		if (this.loaded.has(pcId)) {
			return;
		}
		this.loaded.add(pcId);
		let stored: ConnectionLogEntry[] = [];
		try {
			stored = parseConnectionLog(await this.storage.read(pcId));
		} catch (err) {
			console.warn('[connectionLog] failed to read the connection log', err);
		}
		const appended = this.entries.get(pcId) ?? [];
		this.entries.set(pcId, [...stored, ...appended].slice(-CONNECTION_LOG_LIMIT));
		this.changed();
	}

	append(pcId: string, event: ConnectionLogEventInput): void {
		const list = this.entries.get(pcId) ?? [];
		list.push(normalizeConnectionEntry(event, this.now()));
		if (list.length > CONNECTION_LOG_LIMIT) {
			list.splice(0, list.length - CONNECTION_LOG_LIMIT);
		}
		this.entries.set(pcId, list);
		this.dirty.add(pcId);
		this.scheduleFlush();
		this.changed();
	}

	/** 古い順の記録（画面は新しい順に並べ替える）。 */
	list(pcId: string): readonly ConnectionLogEntry[] {
		return this.entries.get(pcId) ?? [];
	}

	/** 画面の購読用の世代（追記のたびに進む）。 */
	get revision(): number {
		return this.version;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** そのPCの記録を捨てる（ペアリング解除）。 */
	async forget(pcId: string): Promise<void> {
		this.entries.delete(pcId);
		this.dirty.delete(pcId);
		this.changed();
		await this.enqueue(() => this.storage.remove(pcId));
	}

	/** 溜まっている分をすぐ書く（アプリが裏へ回るとき）。 */
	async flush(): Promise<void> {
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const pcIds = [...this.dirty];
		this.dirty.clear();
		await Promise.all(pcIds.map(pcId => {
			const snapshot = JSON.stringify(this.entries.get(pcId) ?? []);
			return this.enqueue(() => this.storage.write(pcId, snapshot));
		}));
	}

	private scheduleFlush(): void {
		if (this.flushTimer !== undefined) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, this.flushDelayMs);
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		this.writeChain = this.writeChain.then(operation).catch(err => console.warn('[connectionLog] failed to write the connection log', err));
		return this.writeChain;
	}

	private changed(): void {
		this.version++;
		for (const listener of this.listeners) {
			listener();
		}
	}
}

/** close code の意味（分かっているものだけ）。 */
const CLOSE_CODE_MEANING: Readonly<Record<number, string>> = {
	0: 'アプリ側で閉じた、または理由不明',
	1000: '正常に閉じられた',
	1001: '相手が離れた',
	1006: '経路の異常（応答なしで切れた）',
	1011: 'リレーの内部エラー',
	4000: '暗号の異常',
	4001: '接続の時間切れ',
	4002: '張り直し',
	4401: 'リレーが資格を拒否',
	4404: 'リレーに登録が無い',
	4410: 'PC がこの端末を失効させた',
};

/** 記録1件を人が読む文にする（画面と報告で共用）。 */
export function describeConnectionEntry(entry: ConnectionLogEntry): string {
	const code = (entry as { code?: number }).code;
	const codeText = code !== undefined ? `コード ${code}${CLOSE_CODE_MEANING[code] !== undefined ? `: ${CLOSE_CODE_MEANING[code]}` : ''}` : undefined;
	const detail = entry.detail !== undefined ? `（${entry.detail}）` : '';
	switch (entry.kind) {
		case 'connecting': {
			const attempt = (entry as { attempt?: number }).attempt ?? 0;
			return attempt > 0 ? `接続を開始（${attempt} 回目の再試行）` : '接続を開始';
		}
		case 'online':
			return 'つながりました（暗号の握手が完了）';
		case 'closed':
			return `切断されました${codeText !== undefined ? `（${codeText}）` : ''}`;
		case 'connect-timeout':
			return '12 秒以内につながらず、打ち切りました';
		case 'socket-error':
			return `通信エラー${detail}`;
		case 'auth-rejected':
			return `リレーがこの端末の資格を拒みました${codeText !== undefined ? `（${codeText}）` : ''}。PC とペアリングし直す必要があります`;
		case 'reconnect-scheduled': {
			const delayMs = (entry as { delayMs?: number }).delayMs ?? 0;
			// 前面復帰・回線の変化・心拍で、待たずに前倒しで繋ぎ直すことがあるので「最大」と書く。
			return `最大 ${formatDelay(delayMs)}後に再接続します`;
		}
		case 'suspended':
			return 'アプリが裏に回ったので接続を閉じました';
		case 'resumed':
			return '前面に戻ったので接続し直します';
		case 'pc-presence':
			return (entry as { online?: boolean }).online === true ? 'PC がリレーにつながっています' : 'PC がリレーにつながっていません';
		case 'pc-restarted':
			return 'PC の Para Code が再起動したので張り直します';
		case 'network-change':
			return `回線が変わりました${detail}`;
		case 'grace-requested':
			return '裏に回ったことを PC に知らせ、接続を保てるか確かめています';
		case 'grace-held':
			return 'PC が確認したので、30 秒まで接続を保ちます';
		case 'grace-refused':
			return `PC の確認が無かったので、すぐ接続を閉じます${detail}`;
		case 'grace-ended':
			return `裏での接続の保持を終えました${detail}`;
		default:
			return (entry as { kind: string }).kind;
	}
}

function formatDelay(ms: number): string {
	if (ms < 1_000) {
		return `${ms} ミリ秒`;
	}
	const seconds = ms / 1_000;
	return seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒` : `${Math.round(seconds / 60)} 分`;
}

/** 報告に載せる時刻（端末のタイムゾーンの 24 時間表記）。 */
export function formatLogTime(at: number): string {
	const date = new Date(at);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 報告（クリップボードへコピーする文）。PC の名前は伏せ、「PC 1」「PC 2」と書く。 */
export function formatConnectionReport(input: {
	readonly appVersion: string;
	readonly generatedAt: number;
	readonly diagnostics: readonly { readonly label: string; readonly status: string; readonly detail: string }[];
	readonly pcs: readonly { readonly entries: readonly ConnectionLogEntry[]; readonly summary: string }[];
}): string {
	const lines: string[] = [
		'Para Code Mobile 接続の記録',
		`アプリ ${input.appVersion} / 作成 ${formatLogTime(input.generatedAt)}`,
		'',
		'## 診断',
		...input.diagnostics.map(item => `- [${item.status}] ${item.label}: ${redactConnectionDetail(item.detail)}`),
	];
	input.pcs.forEach((pc, index) => {
		lines.push('', `## PC ${index + 1}（${pc.summary}）`);
		if (pc.entries.length === 0) {
			lines.push('（記録なし）');
		}
		for (const entry of pc.entries) {
			lines.push(`${formatLogTime(entry.at)} ${describeConnectionEntry(entry)}`);
		}
	});
	return lines.join('\n');
}
