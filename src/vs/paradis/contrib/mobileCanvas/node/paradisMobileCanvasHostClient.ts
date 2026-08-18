/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 同梱している Mobile Canvas (redth.mobile-canvas) の「ホスト」プロセスへ話すためのクライアント。
//
// ホストは mobile-canvas 本体が持つ per-user シングルトンで、127.0.0.1 のみにバインドした
// HTTP サーバーとして iOS シミュレータ / Android エミュレータを束ねる。接続情報は
// `~/.mobile-canvas/hosts/v<protocol>/host.json` に置かれ、Bearer の control token で認証する。
//
// このクライアントはホストを「見つける」「無ければ起動する」「REST を叩く」の3つだけを持ち、
// どのペインがどの端末を触ってよいかという判断は一切しない（それは ParadisMobileCanvasService の仕事）。

import { spawn } from 'child_process';
import { constants as fsConstants } from 'fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { gunzipSync } from 'zlib';
import { CancellationError } from '../../../../base/common/errors.js';
import { join } from '../../../../base/common/path.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** `host.json` の中身。C# 側の `HostMetadata` に対応する。 */
interface IHostMetadata {
	readonly schemaVersion: string;
	readonly processId: number;
	readonly port: number;
	readonly controlToken: string;
	readonly version: string;
}

/**
 * Mobile Canvas の `dist/runtimes/manifest.json` のうち、ここで使う部分だけ。
 *
 * 同梱している拡張はランタイム非同梱版なので、各ファイルは拡張の中の `archive`（ローカルの .gz）
 * ではなく `asset`（GitHub Release のアセット名）を指す。**ネイティブ実行ファイルをアプリの中に
 * 置かないのは macOS の公証を通すためで、意図的な構成**（同梱すると Apple が .gz を展開して
 * 中の未署名 Mach-O を見つけ、アプリ全体の公証が拒否される）。
 */
interface IRuntimeManifest {
	readonly runtimes: {
		readonly [platformKey: string]: {
			readonly rid: string;
			readonly executable: string;
			readonly id: string;
			readonly files: {
				readonly [name: string]: {
					/** 拡張に同梱されている場合の相対パス。非同梱版には無い。 */
					readonly archive?: string;
					/** GitHub Release から取る場合のアセット名。 */
					readonly asset?: string;
					readonly sha256: string;
					readonly size: number;
				};
			};
		};
	};
	/** ランタイムの取得元。非同梱版で `asset` を解決するのに使う。 */
	readonly distribution?: { readonly repository: string; readonly tag: string };
}

/** ホストが応答しない・起動できないなど、Mobile Canvas 側の都合で失敗したことを表す。 */
export class ParadisMobileCanvasUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ParadisMobileCanvasUnavailableError';
	}
}

const HOST_STARTUP_TIMEOUT_MS = 20_000;
const HOST_HEALTH_TIMEOUT_MS = 750;
const REQUEST_TIMEOUT_MS = 60_000;
/** gunzip 後の実行ファイルサイズの上限。manifest の申告値が壊れていた場合の歯止め。 */
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
/** 圧縮済みアーカイブの上限。壊れた応答を丸ごとメモリに載せないための歯止め。 */
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
/** ランタイム取得は初回のみ・数十MBなので、通常のREST呼び出しより長く待つ。 */
const RUNTIME_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export class ParadisMobileCanvasHostClient {

	private _metadata: IHostMetadata | undefined;
	/** 起動の取り合いを防ぐための直列化。複数ペインが同時に最初のツールを呼んでも1回しか起動しない。 */
	private _starting: Promise<IHostMetadata> | undefined;
	/** 実行ファイルの解決結果のキャッシュ（gunzip と sha256 検証を毎回やらないため）。 */
	private _executable: Promise<string> | undefined;

	constructor(
		private readonly _builtinExtensionsPath: string,
		private readonly _logService: ILogService,
	) { }

	/**
	 * ホストの REST API を叩く。ホストが動いていなければ起動を試みる。
	 *
	 * @param path `/api/v1/...` 形式のパス
	 */
	async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const metadata = await this._ensureStarted(signal);
		const response = await this._send(metadata, method, path, body, REQUEST_TIMEOUT_MS, signal);
		if (!response.ok) {
			throw new ParadisMobileCanvasUnavailableError(await this._describeFailure(response));
		}
		if (response.status === 204) {
			return undefined;
		}
		const text = await response.text();
		if (!text) {
			return undefined;
		}
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	/** スクリーンショットのようにバイナリを返すエンドポイント用。 */
	async requestBinary(path: string, signal?: AbortSignal): Promise<Uint8Array> {
		const metadata = await this._ensureStarted(signal);
		const response = await this._send(metadata, 'GET', path, undefined, REQUEST_TIMEOUT_MS, signal);
		if (!response.ok) {
			throw new ParadisMobileCanvasUnavailableError(await this._describeFailure(response));
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	/**
	 * ホストのエラー応答を人間に読める1行にする。Mobile Canvas は `{code, message}` を返すので
	 * それを優先し、読めなければステータス行にフォールバックする。
	 */
	private async _describeFailure(response: Response): Promise<string> {
		try {
			const error = await response.json() as { code?: unknown; message?: unknown };
			if (typeof error?.message === 'string' && error.message) {
				return typeof error.code === 'string' && error.code ? `${error.code}: ${error.message}` : error.message;
			}
		} catch {
			// JSON でない応答もありうる。下のフォールバックで十分。
		}
		return `Mobile Canvas host returned ${response.status} ${response.statusText}.`;
	}

	private async _send(metadata: IHostMetadata, method: string, path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
		const timeout = AbortSignal.timeout(timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		try {
			return await fetch(`http://127.0.0.1:${metadata.port}${path}`, {
				method,
				headers: {
					'Authorization': `Bearer ${metadata.controlToken}`,
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: combined,
			});
		} catch (error) {
			if (signal?.aborted) {
				throw new CancellationError();
			}
			throw new ParadisMobileCanvasUnavailableError(`Could not reach the Mobile Canvas host: ${toMessage(error)}`);
		}
	}

	private async _ensureStarted(signal?: AbortSignal): Promise<IHostMetadata> {
		const cached = this._metadata;
		if (cached && await this._isHealthy(cached)) {
			return cached;
		}
		this._metadata = undefined;
		// 起動処理が走っている間に来た呼び出しは、同じ Promise に相乗りさせる。
		this._starting ??= this._start(signal).finally(() => { this._starting = undefined; });
		return this._starting;
	}

	private async _start(signal?: AbortSignal): Promise<IHostMetadata> {
		// 既に誰か（Mobile Canvas の VS Code 拡張など）が起動しているホストがあればそれに乗る。
		const existing = await this._readMetadata();
		if (existing && await this._isHealthy(existing)) {
			this._metadata = existing;
			return existing;
		}

		const executable = await this._resolveExecutable();
		this._logService.info('[paradis-mobile-canvas] starting the Mobile Canvas host');
		const child = spawn(executable, ['host', 'run'], {
			cwd: homedir(),
			env: { ...process.env, MOBILE_CANVAS_HOST_PROCESS: '1' },
			stdio: 'ignore',
			// ホストは per-user シングルトンで、Para Code のウィンドウより長生きしてよい。
			detached: true,
		});
		child.unref();
		child.on('error', error => this._logService.error('[paradis-mobile-canvas] failed to spawn the host', error));

		const deadline = Date.now() + HOST_STARTUP_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new CancellationError();
			}
			await delay(100);
			const candidate = await this._readMetadata();
			if (candidate && await this._isHealthy(candidate)) {
				this._metadata = candidate;
				return candidate;
			}
		}
		throw new ParadisMobileCanvasUnavailableError('The Mobile Canvas host did not become ready within 20 seconds.');
	}

	/**
	 * `~/.mobile-canvas/hosts/v*​/host.json` を読む。プロトコル版ごとにディレクトリが分かれるため、
	 * 版を決め打ちせず「読めたもの」を採用する（同梱版が上がってディレクトリ名が変わっても追従できる）。
	 */
	private async _readMetadata(): Promise<IHostMetadata | undefined> {
		const hostsRoot = join(homedir(), '.mobile-canvas', 'hosts');
		let entries: string[];
		try {
			entries = await readdir(hostsRoot);
		} catch {
			return undefined;
		}
		for (const entry of entries.sort().reverse()) {
			try {
				const raw = await readFile(join(hostsRoot, entry, 'host.json'), 'utf8');
				const metadata = normalizeMetadata(JSON.parse(raw));
				if (metadata) {
					return metadata;
				}
			} catch {
				// 版ディレクトリが残っているだけで host.json が無いこともある。次を見る。
			}
		}
		return undefined;
	}

	private async _isHealthy(metadata: IHostMetadata): Promise<boolean> {
		try {
			const response = await this._send(metadata, 'GET', '/api/v1/status', undefined, HOST_HEALTH_TIMEOUT_MS);
			return response.ok;
		} catch {
			return false;
		}
	}

	/**
	 * 同梱の Mobile Canvas 拡張が持つ gzip 済みネイティブランタイムを、内容アドレスの
	 * キャッシュディレクトリへ展開して実行ファイルのパスを返す。
	 *
	 * 展開先は Mobile Canvas 自身（`lib/runtime.mjs`）と同じ `~/.mobile-canvas/runtimes/<key>-<hash>` に
	 * 揃えてあるので、拡張側が先に展開していればそれをそのまま使い、二重展開にならない。
	 */
	private _resolveExecutable(): Promise<string> {
		this._executable ??= this._materializeRuntime().catch(error => {
			// 失敗を握ったままキャッシュすると、原因を直しても復帰できなくなる。
			this._executable = undefined;
			throw error;
		});
		return this._executable;
	}

	private async _materializeRuntime(): Promise<string> {
		const runtimesDir = join(this._builtinExtensionsPath, 'mobile-canvas-vscode', 'dist', 'runtimes');
		let manifest: IRuntimeManifest;
		try {
			manifest = JSON.parse(await readFile(join(runtimesDir, 'manifest.json'), 'utf8')) as IRuntimeManifest;
		} catch (error) {
			throw new ParadisMobileCanvasUnavailableError(`The bundled Mobile Canvas runtime is missing: ${toMessage(error)}`);
		}

		const platformKey = `${process.platform}-${process.arch}`;
		const entry = manifest.runtimes?.[platformKey];
		if (!entry) {
			throw new ParadisMobileCanvasUnavailableError(`Mobile Canvas does not ship a runtime for ${platformKey}.`);
		}

		const target = join(homedir(), '.mobile-canvas', 'runtimes', `${platformKey}-${entry.id.slice(0, 12)}`);
		const resolved = join(target, entry.executable);
		try {
			await access(resolved, fsConstants.X_OK);
			return resolved;
		} catch {
			// まだ展開されていない。以下で展開する。
		}

		const cacheRoot = join(homedir(), '.mobile-canvas', 'runtimes');
		await mkdir(cacheRoot, { recursive: true });
		const staging = await mkdtemp(join(cacheRoot, '.paradis-staging-'));
		try {
			for (const [name, file] of Object.entries(entry.files)) {
				if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_RUNTIME_BYTES) {
					throw new ParadisMobileCanvasUnavailableError(`Invalid declared runtime size for ${name}: ${file.size}`);
				}
				const packed = file.archive
					? await readFile(join(runtimesDir, file.archive))
					: await this._downloadArchive(manifest, file.asset);
				const bytes = gunzipSync(packed, { maxOutputLength: file.size });
				const actual = createHash('sha256').update(bytes).digest('hex');
				if (actual !== file.sha256) {
					throw new ParadisMobileCanvasUnavailableError(`Checksum mismatch for the bundled Mobile Canvas runtime ${name}.`);
				}
				await writeFile(join(staging, name), bytes);
				await chmod(join(staging, name), 0o755);
			}
			try {
				await rename(staging, target);
			} catch {
				// 別のプロセスが先に同じ内容を置いた場合は、その成果物をそのまま使う。
				await access(resolved, fsConstants.X_OK);
			}
			return resolved;
		} finally {
			await rm(staging, { recursive: true, force: true }).catch(() => { });
		}
	}

	/**
	 * ランタイムのアーカイブを GitHub Release から取る。展開後の sha256 は呼び出し側で
	 * manifest の値と突き合わせるので、ここでは大きさの上限だけ見る。
	 */
	private async _downloadArchive(manifest: IRuntimeManifest, asset: string | undefined): Promise<Buffer> {
		const distribution = manifest.distribution;
		if (!asset || !distribution?.repository || !distribution?.tag) {
			throw new ParadisMobileCanvasUnavailableError('The Mobile Canvas runtime manifest does not say where to download the runtime from.');
		}
		const url = `https://github.com/${distribution.repository}/releases/download/${distribution.tag}/${asset}`;
		this._logService.info(`[paradis-mobile-canvas] downloading the Mobile Canvas runtime (${asset})`);
		let response: Response;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(RUNTIME_DOWNLOAD_TIMEOUT_MS) });
		} catch (error) {
			throw new ParadisMobileCanvasUnavailableError(`Could not download the Mobile Canvas runtime: ${toMessage(error)}`);
		}
		if (!response.ok) {
			throw new ParadisMobileCanvasUnavailableError(`Could not download the Mobile Canvas runtime: ${response.status} ${response.statusText}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARCHIVE_BYTES) {
			throw new ParadisMobileCanvasUnavailableError(`The downloaded Mobile Canvas runtime has an unexpected size (${bytes.byteLength} bytes).`);
		}
		return Buffer.from(bytes);
	}
}

function normalizeMetadata(raw: unknown): IHostMetadata | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	// System.Text.Json の設定次第で PascalCase / camelCase のどちらでも書かれうるため両方読む。
	const record = raw as Record<string, unknown>;
	const pick = (name: string): unknown => record[name] ?? record[name.charAt(0).toUpperCase() + name.slice(1)];
	const port = pick('port');
	const controlToken = pick('controlToken');
	if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || typeof controlToken !== 'string' || !controlToken) {
		return undefined;
	}
	return {
		schemaVersion: typeof pick('schemaVersion') === 'string' ? pick('schemaVersion') as string : '',
		processId: typeof pick('processId') === 'number' ? pick('processId') as number : 0,
		port,
		controlToken,
		version: typeof pick('version') === 'string' ? pick('version') as string : '',
	};
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
