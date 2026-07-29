/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// アプリ本体の remote-debugging ポートを electron-main 側で1度だけ確定させ、以降ずっと同じ値を
// 返す小さな部品。shared process の CDP ゲートウェイはここに聞く。
//
// なぜ main が持つのか:
// `<userDataDir>/DevToolsActivePort` は Chromium が書くが、**2つ目の Para Code プロセス**
// （macOS の `open -n`、Dock からの二重起動、自動アップデートの適用時など）が起動すると、
// シングルインスタンスロックに気づいて終了する前に自分のポートで上書きしてしまう。残るのは
// 誰も listen していない番号で、ファイルを読み直しても永久に直らない。
//
// shared process 側は「一度でも応答が返ったポート」を覚えることで、繋がった後の上書きからは
// 自力で戻れる（paracode-81）。しかし**起動時点で既に上書きされていた**場合は実績が無く、
// 死んだポートしか候補が無いのでブラウザ共有が壊れたままになる。
//
// main はこのファイルを書いた本人のプロセスなので、起動直後に読めば上書きより先回りできる。
// さらに main には決定的な身元確認手段がある: 候補ポートの `/json/list` から targetId を取り、
// `webContents.fromDevToolsTargetId()` が**このプロセスの WebContents** を返すかを見ればよい。
// バージョン文字列の一致（shared process 側の手当て）と違い、同じ Chromium を積んだもう1つの
// Para Code とも取り違えない。

import * as electron from 'electron';
import { paradisReadDevToolsActivePort } from '../node/paradisCdpUpstream.js';

/** `/json/list` の取得に許す時間。ローカルの HTTP なので短くてよい。 */
const FETCH_TIMEOUT_MS = 2_000;
/**
 * 確定を諦めるまでの上限。
 *
 * 待つ相手は2つある: `DevToolsActivePort` が書かれること（起動直後のごく短い間）と、
 * 自分のウィンドウが `/json/list` に現れること。後者は拡張が多い・ウィンドウ復元が重い環境では
 * 数十秒かかりうる。ここを短くすると「まだウィンドウが無いだけ」の失敗をクールダウンで
 * 覚え込み、冷スタートを救うはずの経路が壊れたファイル読みへ落ちてしまう。
 */
const PIN_TIMEOUT_MS = 30_000;
const PIN_RETRY_INTERVAL_MS = 500;
/**
 * 確定に失敗したあと、次の試行を始めるまで空ける時間。
 * remote debugging が本当に使えない構成（`--remote-debugging-pipe` 指定など）では確定は永久に
 * 成功しないので、聞かれるたびに30秒のリトライループを回さないための歯止め。
 */
const PIN_RETRY_COOLDOWN_MS = 30_000;
/**
 * `/json/list` の応答上限。**読みながら**測って超えたら切る。
 *
 * 相手はポート番号を再利用した無関係なローカルサーバかもしれず、chunked で延々と返してくる
 * ことがある。ここは main プロセスなので、読み切ってから長さを見ると、その間に積み上がった
 * ヒープでウィンドウごと固まる。ターゲット一覧は数KiBに収まるものなので上限も小さくてよい。
 */
const MAX_LIST_BYTES = 256 * 1024;
/**
 * 身元確認に使うターゲットの上限。`fromDevToolsTargetId` は同期のネイティブ呼び出しなので、
 * 大量の id を渡されると main のイベントループが止まる。自分のウィンドウが1つでも混じって
 * いれば確認は足りるので、先頭だけ見れば十分。
 *
 * 切る前に `page` へ絞るのは、`/json/list` が page / worker / iframe / service_worker を
 * **順序保証なしで混ぜて返す**ため。実測（稼働中の Para Code）で26件中 page は10件だったので
 * 上限までは大きな余裕があるが、絞っておけば「自分の page が上限より後ろに来て身元確認に
 * 失敗し、静かに壊れたファイル読みへ戻る」経路そのものが消える。
 */
const MAX_LIST_TARGETS = 256;

export interface IParadisCdpUpstreamPortPinOptions {
	/** `DevToolsActivePort` を置いているディレクトリ。既定は Electron の userData。 */
	readonly userDataPath?: string;
	readonly readPortFile?: (userDataPath: string) => Promise<number | undefined>;
	/** 候補ポートの `/json/list` から targetId を取り出す。 */
	readonly fetchTargetIds?: (port: number) => Promise<readonly string[]>;
	/** その targetId がこのプロセスの WebContents を指すか。 */
	readonly ownsTargetId?: (targetId: string) => boolean;
	readonly timeoutMs?: number;
	readonly retryIntervalMs?: number;
	readonly retryCooldownMs?: number;
	readonly delay?: (ms: number) => Promise<void>;
	readonly now?: () => number;
}

function defaultDelay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** `/json/list` を読み、要素の `id` だけを取り出す。応答は読みながら上限で切る。 */
async function defaultFetchTargetIds(port: number): Promise<readonly string[]> {
	const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	if (!response.ok) {
		throw new Error(`Upstream CDP returned ${response.status} for /json/list`);
	}
	const value: unknown = JSON.parse(await readBoundedText(response));
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.filter(entry => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'page')
		.slice(0, MAX_LIST_TARGETS)
		.map(entry => (entry as { id?: unknown }).id)
		.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/** 本文を読みながら上限で打ち切る。超えた時点で読むのをやめる（読み切ってから測らない）。 */
export async function readBoundedText(response: Response): Promise<string> {
	if (!response.body) {
		throw new Error('Upstream CDP /json/list response has no readable body');
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			total += value.byteLength;
			if (total > MAX_LIST_BYTES) {
				await reader.cancel();
				throw new Error('Upstream CDP /json/list response exceeds the byte limit');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

/**
 * このプロセスが所有する DevTools ターゲットかを見る。
 * 他のアプリ（あるいはもう1つの Para Code）のエンドポイントなら、その targetId は
 * こちらの `webContents` には存在しないので undefined が返る。
 */
function defaultOwnsTargetId(targetId: string): boolean {
	try {
		return !!electron.webContents.fromDevToolsTargetId(targetId);
	} catch {
		return false;
	}
}

/**
 * 上流 CDP ポートを1度だけ確定して保持する。
 *
 * `pin()` は何度呼んでも安全で、確定済みなら即返る。確定するまでは同じ1本の試行を共有するので、
 * 起動時の先行呼び出しと shared process からの問い合わせが重なっても二重に走らない。
 */
export class ParadisCdpUpstreamPortPin {

	private _pinnedPort: number | undefined;
	/** 進行中の確定処理。失敗したら捨てて、次の呼び出しでやり直せるようにする。 */
	private _pinning: Promise<number | undefined> | undefined;

	private readonly userDataPath: string | undefined;
	private readonly readPortFile: (userDataPath: string) => Promise<number | undefined>;
	private readonly fetchTargetIds: (port: number) => Promise<readonly string[]>;
	private readonly ownsTargetId: (targetId: string) => boolean;
	private readonly timeoutMs: number;
	private readonly retryIntervalMs: number;
	private readonly retryCooldownMs: number;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly now: () => number;
	/** 直近の失敗が終わった時刻。次の試行までの間隔を空けるために持つ。 */
	private _lastFailureAt: number | undefined;

	constructor(options: IParadisCdpUpstreamPortPinOptions = {}) {
		// 既定値をここで解決せず遅延させるのは、テストが素の Node で走り electron を持たないため。
		this.userDataPath = options.userDataPath;
		this.readPortFile = options.readPortFile ?? paradisReadDevToolsActivePort;
		this.fetchTargetIds = options.fetchTargetIds ?? defaultFetchTargetIds;
		this.ownsTargetId = options.ownsTargetId ?? defaultOwnsTargetId;
		this.timeoutMs = options.timeoutMs ?? PIN_TIMEOUT_MS;
		this.retryIntervalMs = options.retryIntervalMs ?? PIN_RETRY_INTERVAL_MS;
		this.retryCooldownMs = options.retryCooldownMs ?? PIN_RETRY_COOLDOWN_MS;
		this.delay = options.delay ?? defaultDelay;
		this.now = options.now ?? Date.now;
	}

	/** 確定済みのポート。まだ確定していなければ undefined（`pin()` を待つこと）。 */
	get pinnedPort(): number | undefined {
		return this._pinnedPort;
	}

	/**
	 * ポートを確定する。**アプリが生きている間このポートは変わらない**ので、一度成功したら
	 * 二度と読み直さない（読み直せば上書きされたファイルを掴む危険が戻ってくるだけ）。
	 */
	pin(): Promise<number | undefined> {
		if (this._pinnedPort !== undefined) {
			return Promise.resolve(this._pinnedPort);
		}
		if (this._pinning === undefined
			&& this._lastFailureAt !== undefined
			&& this.now() - this._lastFailureAt < this.retryCooldownMs) {
			return Promise.resolve(undefined);
		}
		// `_pin` は例外を投げない作りだが、投げても呼び出し側（IPC 越し）へ伝えない。
		this._pinning ??= this._pin()
			.catch(() => undefined)
			.finally(() => {
				if (this._pinnedPort === undefined) {
					this._lastFailureAt = this.now();
				}
				this._pinning = undefined;
			});
		return this._pinning;
	}

	/**
	 * 確定済みならその場で返し、まだなら確定を走らせつつ `waitMs` だけ待つ。
	 *
	 * 間に合わなければ undefined を返すが、**確定処理は裏で続く**ので次の呼び出しで拾える。
	 * 呼び出し側（shared process の CDP ゲートウェイ）は確定を待てる立場ではなく、待たせると
	 * 上流が使えない構成のときにブラウザ操作のたびに固まって見えるため、必ず短く区切る。
	 */
	async resolveWithin(waitMs: number): Promise<number | undefined> {
		if (this._pinnedPort !== undefined) {
			return this._pinnedPort;
		}
		const pinning = this.pin();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				pinning,
				new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), waitMs); }),
			]);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	private async _pin(): Promise<number | undefined> {
		const userDataPath = this.resolveUserDataPath();
		if (userDataPath === undefined) {
			return undefined;
		}
		const deadline = this.now() + this.timeoutMs;
		for (; ;) {
			const candidate = await this.readPortFile(userDataPath).catch(() => undefined);
			if (candidate !== undefined && await this.isOwnEndpoint(candidate)) {
				this._pinnedPort = candidate;
				return candidate;
			}
			if (this.now() >= deadline) {
				// 起動時点で既に他インスタンスに上書きされていた場合はここに来る。呼び出し側は
				// 従来どおりファイル直読みへフォールバックする（それ以上できることは無い）。
				return undefined;
			}
			await this.delay(this.retryIntervalMs);
		}
	}

	private async isOwnEndpoint(port: number): Promise<boolean> {
		let targetIds: readonly string[];
		try {
			targetIds = await this.fetchTargetIds(port);
		} catch {
			return false;
		}
		// 1つも自分のターゲットが無いエンドポイントは他人のもの。ターゲットが空の応答も
		// 「自分だと確かめられなかった」として弾く（ワークベンチウィンドウが必ず1つはある）。
		return targetIds.some(targetId => this.ownsTargetId(targetId));
	}

	private resolveUserDataPath(): string | undefined {
		if (this.userDataPath !== undefined) {
			return this.userDataPath;
		}
		try {
			return electron.app.getPath('userData');
		} catch {
			return undefined;
		}
	}
}
