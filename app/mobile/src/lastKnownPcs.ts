// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { fromBase64Url, openNotify, sealNotify, toBase64Url } from '@para/protocol';
import { statusBucket } from './homeSort.js';

/**
 * 起動直後に出す「前回の一覧」（W2-25。Orca の home-snapshot-cache.ts に倣った）。
 *
 * 状態が届くまでのあいだ、PC の画面は「接続しています…」、ホームの PC のカードは名前だけだった。
 * 最後に受け取った一覧の要約を端末へ残しておき、起動直後から「最終確認 ○分前」付きで出す。
 *
 * **残すのはスペースの名前と件数・状態だけ。** ターミナルの題名にはコマンドや作業内容が出ることが
 * あるので残さない（Q118 A。題名は接続してから出す）。ファイルは操作の outbox と同じ通知鍵で
 * 封緘する（鍵は Keychain の長期鍵と PC の公開鍵から毎回導く。ファイルだけ持ち出しても読めない）。
 *
 * **ここにある値は「前に見えたもの」でしかない。** 操作してよいか（スペースがあるか、起動できるか）の
 * 判断には使わない。画面は読み取り専用で出し、接続して State が届いたら生きた一覧へ切り替える。
 */

/** 1スペースぶんの要約。 */
export interface LastKnownSpace {
	readonly name: string;
	/** そのスペースのターミナルの数（エージェントを含む）。 */
	readonly terminals: number;
	/** 状態ごとのエージェントの数（アーカイブしたものは数えない）。 */
	readonly waiting: number;
	readonly working: number;
	readonly review: number;
	readonly idle: number;
}

export interface LastKnownPcSnapshot {
	/** 封緘の中で名乗る PC。別の PC のファイルを読まされたときに弾く。 */
	readonly pcId: string;
	/** 最後に State を受け取った時刻（epoch ms）。「最終確認 ○分前」の元。 */
	readonly savedAt: number;
	readonly spaces: readonly LastKnownSpace[];
}

/** 残すスペースの数と名前の長さの上限（壊れた・細工されたファイルで画面を埋めない）。 */
export const LAST_KNOWN_MAX_SPACES = 100;
export const LAST_KNOWN_MAX_NAME_LENGTH = 120;
const LAST_KNOWN_MAX_COUNT = 10_000;
const SNAPSHOT_VERSION = 1;
/** 封緘の中の用途の印（同じ鍵で封緘する outbox・通知と取り違えないため）。 */
const SNAPSHOT_PURPOSE = 'para.last-known-pc';

/** 要約を作るのに要る State の形（実体は `WorkspaceState`）。 */
export interface LastKnownSource {
	readonly activeWs: string | undefined;
	readonly workspaces: readonly { readonly id: string; readonly name: string }[];
	readonly terminals: readonly { readonly terminalKey: string; readonly ws?: string; readonly agent?: boolean; readonly agentStatus?: string }[];
}

/**
 * State から要約を作る。ターミナルは PC の画面と同じ規則でスペースへ振り分ける（`ws` → いまの
 * スペース → 先頭。`pcList.ts` の `resolveTerminalSpace`）。題名は読まない。
 */
export function buildLastKnownSnapshot(pcId: string, source: LastKnownSource, isArchived: (terminalKey: string) => boolean, now: number): LastKnownPcSnapshot {
	const spaces = source.workspaces.slice(0, LAST_KNOWN_MAX_SPACES);
	const counts = new Map<string, { terminals: number; waiting: number; working: number; review: number; idle: number }>();
	for (const space of spaces) {
		counts.set(space.id, { terminals: 0, waiting: 0, working: 0, review: 0, idle: 0 });
	}
	const byId = (id: string | undefined) => (id === undefined ? undefined : counts.get(id));
	for (const terminal of source.terminals) {
		const owner = byId(terminal.ws) ?? byId(source.activeWs) ?? (spaces[0] !== undefined ? counts.get(spaces[0].id) : undefined);
		if (owner === undefined) {
			continue;
		}
		owner.terminals++;
		if (terminal.agent === true && !isArchived(terminal.terminalKey)) {
			owner[statusBucket(terminal.agentStatus)]++;
		}
	}
	return {
		pcId,
		savedAt: now,
		spaces: spaces.map(space => ({ name: clampName(space.name), ...counts.get(space.id)! })),
	};
}

/** 同じ中身か（保存を間引くため。`savedAt` は比べない）。 */
export function sameLastKnownContent(a: LastKnownPcSnapshot | undefined, b: LastKnownPcSnapshot): boolean {
	if (a === undefined || a.pcId !== b.pcId || a.spaces.length !== b.spaces.length) {
		return false;
	}
	return a.spaces.every((space, index) => {
		const other = b.spaces[index]!;
		return space.name === other.name && space.terminals === other.terminals && space.waiting === other.waiting
			&& space.working === other.working && space.review === other.review && space.idle === other.idle;
	});
}

/** 通知鍵で封緘して base64url にする（ファイルへ書く形）。 */
export function sealLastKnownSnapshot(key: Uint8Array, snapshot: LastKnownPcSnapshot): string {
	const plaintext = JSON.stringify({ v: SNAPSHOT_VERSION, purpose: SNAPSHOT_PURPOSE, ...snapshot });
	return toBase64Url(sealNotify(key, new TextEncoder().encode(plaintext)));
}

/**
 * 封緘を開いて要約へ戻す。鍵が違う・壊れている・別の PC のもの・形が合わないときは undefined
 * （呼び出し側は「前回の一覧は無い」として扱う）。
 */
export function openLastKnownSnapshot(key: Uint8Array, sealed: string, pcId: string): LastKnownPcSnapshot | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(openNotify(key, fromBase64Url(sealed))));
	} catch {
		return undefined;
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return undefined;
	}
	const record = raw as { v?: unknown; purpose?: unknown; pcId?: unknown; savedAt?: unknown; spaces?: unknown };
	if (record.v !== SNAPSHOT_VERSION || record.purpose !== SNAPSHOT_PURPOSE || record.pcId !== pcId
		|| typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt) || record.savedAt <= 0 || !Array.isArray(record.spaces)) {
		return undefined;
	}
	const spaces: LastKnownSpace[] = [];
	for (const candidate of record.spaces.slice(0, LAST_KNOWN_MAX_SPACES)) {
		const space = parseSpace(candidate);
		if (space === undefined) {
			return undefined;
		}
		spaces.push(space);
	}
	return { pcId, savedAt: record.savedAt, spaces };
}

function parseSpace(value: unknown): LastKnownSpace | undefined {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const space = value as Record<string, unknown>;
	if (typeof space.name !== 'string') {
		return undefined;
	}
	const count = (key: string) => {
		const n = space[key];
		return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= LAST_KNOWN_MAX_COUNT ? n : undefined;
	};
	const terminals = count('terminals');
	const waiting = count('waiting');
	const working = count('working');
	const review = count('review');
	const idle = count('idle');
	if (terminals === undefined || waiting === undefined || working === undefined || review === undefined || idle === undefined) {
		return undefined;
	}
	return { name: clampName(space.name), terminals, waiting, working, review, idle };
}

function clampName(name: string): string {
	return name.length <= LAST_KNOWN_MAX_NAME_LENGTH ? name : name.slice(0, LAST_KNOWN_MAX_NAME_LENGTH);
}

/**
 * 「最終確認 3分前」。`relative` は `time.ts` の `formatRelativeTime` の結果（1分未満の「今」は「たった今」）。
 * `time.ts` は React Native を引くので、ここでは整形済みの語を受け取る（画面側は `lastKnownPcList.tsx`）。
 */
export function lastKnownLabelFor(relative: string): string {
	return `最終確認 ${relative === '今' ? 'たった今' : relative}`;
}

/** 合計（ホームの PC のカードの件数に使う）。 */
export function lastKnownTotals(snapshot: LastKnownPcSnapshot): { readonly spaces: number; readonly agents: number; readonly waiting: number; readonly working: number; readonly review: number; readonly idle: number } {
	let waiting = 0;
	let working = 0;
	let review = 0;
	let idle = 0;
	for (const space of snapshot.spaces) {
		waiting += space.waiting;
		working += space.working;
		review += space.review;
		idle += space.idle;
	}
	return { spaces: snapshot.spaces.length, agents: waiting + working + review + idle, waiting, working, review, idle };
}

/** 要約の置き場（実体は `lastKnownPcStore.ts` のアプリ sandbox 内ファイル）。 */
export interface LastKnownPcStorage {
	read(pcId: string): Promise<string | null>;
	write(pcId: string, sealed: string): Promise<void>;
	remove(pcId: string): Promise<void>;
}

/**
 * 保存の間引き。State は実行中で最大10Hz届くので、PC ごとに最後の1件だけを少し遅らせて書く。
 * 中身（件数・名前）が前回書いたものと同じなら書かない（時刻だけの更新で毎回書き直さない）。
 * ただし時刻も「最終確認」の元なので、同じ中身でも `refreshMs` を過ぎたら書き直す。
 */
export class LastKnownPcWriter {
	private readonly pending = new Map<string, { snapshot: LastKnownPcSnapshot; key: Uint8Array; timer: ReturnType<typeof setTimeout> }>();
	private readonly written = new Map<string, LastKnownPcSnapshot>();
	/** 書き込みを PC ごとに直列にする（古い書き込みが新しいものを追い越さないように）。 */
	private readonly chains = new Map<string, Promise<void>>();

	constructor(
		private readonly storage: LastKnownPcStorage,
		private readonly delayMs = 1_500,
		private readonly refreshMs = 60_000,
		private readonly timers: { setTimeout(handler: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void } = globalThis,
	) { }

	schedule(key: Uint8Array, snapshot: LastKnownPcSnapshot): void {
		const previous = this.written.get(snapshot.pcId);
		if (previous !== undefined && sameLastKnownContent(previous, snapshot) && snapshot.savedAt - previous.savedAt < this.refreshMs) {
			return;
		}
		const queued = this.pending.get(snapshot.pcId);
		if (queued !== undefined) {
			queued.snapshot = snapshot;
			queued.key = key;
			return;
		}
		const timer = this.timers.setTimeout(() => { void this.flushOne(snapshot.pcId); }, this.delayMs);
		this.pending.set(snapshot.pcId, { snapshot, key, timer });
	}

	/** 予約中の分をすぐ書く（アプリが裏へ回るとき）。 */
	async flush(): Promise<void> {
		await Promise.all([...this.pending.keys()].map(pcId => this.flushOne(pcId)));
	}

	/** その PC の要約を捨てる（ペアリング解除）。予約中の書き込みも取り消す。 */
	async forget(pcId: string): Promise<void> {
		const queued = this.pending.get(pcId);
		if (queued !== undefined) {
			this.timers.clearTimeout(queued.timer);
			this.pending.delete(pcId);
		}
		this.written.delete(pcId);
		await this.enqueue(pcId, () => this.storage.remove(pcId));
	}

	private async flushOne(pcId: string): Promise<void> {
		const queued = this.pending.get(pcId);
		if (queued === undefined) {
			return;
		}
		this.timers.clearTimeout(queued.timer);
		this.pending.delete(pcId);
		this.written.set(pcId, queued.snapshot);
		await this.enqueue(pcId, () => this.storage.write(pcId, sealLastKnownSnapshot(queued.key, queued.snapshot)));
	}

	private enqueue(pcId: string, operation: () => Promise<void>): Promise<void> {
		const next = (this.chains.get(pcId) ?? Promise.resolve()).then(operation).catch(err => console.warn('[lastKnownPcs] failed to write the last known list', err));
		this.chains.set(pcId, next);
		return next;
	}
}
