/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Design Mode の main プロセス側の窓口（app.ts に登録を2行足す方式。CDP で仕掛けを入れる案より
// 配線が少なく保守しやすいため）。
//
// renderer からは内蔵ブラウザのページ（WebContentsView）に直接触れないので、ページへ仕掛けを
// 入れる処理と、画像をディスクへ書く処理をここに置く。できることは固定の仕掛けを流すことと
// PNG を決まった場所へ書くことだけで、任意のスクリプトや任意のパスは受け付けない。
// チャネルは下の5つの呼び出しだけを受け付ける（ProxyChannel.fromService のように、実装の
// 内部のメソッドまで renderer へ見せない）。

import { promises as fs } from 'fs';
import { join } from '../../../../base/common/path.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IServerChannel } from '../../../../base/parts/ipc/common/ipc.js';
import {
	IParadisDesignPin,
	PARADIS_DESIGN_BUDGET,
	PARADIS_DESIGN_MODE_CHANNEL,
	PARADIS_DESIGN_MODE_WORLD_ID,
	ParadisDesignPickResult,
	paradisClampPickedElement,
	paradisIsPng,
} from '../common/paradisDesignMode.js';
import { paradisBuildCancelPickScript, paradisBuildPickScript, paradisBuildSetPinsScript } from '../common/paradisDesignModePageScript.js';

/** 仕掛けを流す先（BrowserView の webContents の最小構造。テストから偽物を渡せるように）。 */
export interface IParadisDesignModeTarget {
	readonly webContents: {
		isDestroyed(): boolean;
		executeJavaScriptInIsolatedWorld(worldId: number, scripts: { code: string }[], userGesture?: boolean): Promise<unknown>;
	};
}

/** ビュー ID から対象を引く（本番は IBrowserViewMainService.tryGetBrowserView）。 */
export type ParadisDesignModeTargetResolver = (viewId: string) => IParadisDesignModeTarget | undefined;

/** 保存した画像を置いておく時間。エージェントが読む前に消さない程度に長く取る。 */
const IMAGE_TTL_MS = 24 * 60 * 60 * 1000;
/** 起動後も定期的に掃除する間隔（保存がそれきり無くても古い画像を残さない）。 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 画像の名前（ここで作った名前以外は掃除の対象にしない）。 */
const IMAGE_NAME_PATTERN = /^design-(?<time>\d+)-[0-9a-f-]{36}\.png$/;

export class ParadisDesignModeMainService extends Disposable {

	/** 呼び出し元のウィンドウ（IPC の ctx）ごとの、選択中のビュー。 */
	private readonly pendingPicks = new Map<string, Set<string>>();

	constructor(
		private readonly resolveTarget: ParadisDesignModeTargetResolver,
		/** 画像を置くディレクトリ（userData 配下）。 */
		private readonly imageDirectory: string,
		private readonly now: () => number = Date.now,
	) {
		super();
	}

	/** 起動時と、その後1時間ごとに古い画像を掃除する。 */
	startCleanupSchedule(): void {
		void this.cleanup();
		const handle = setInterval(() => void this.cleanup(), CLEANUP_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(handle)));
	}

	async pickElement(caller: string, viewId: string, pins: readonly IParadisDesignPin[]): Promise<ParadisDesignPickResult> {
		const target = this.resolveLive(viewId);
		if (!target) {
			return { kind: 'cancelled' };
		}
		// 呼び出しごとの使い捨ての値。ページの仕掛けは結果にこれを載せて返す。前から置かれていた
		// 偽の仕掛け（CDP から入れられたもの）や、前の回の結果を取り違えないための照合に使う
		const nonce = generateUuid();
		const views = this.pendingPicks.get(caller) ?? new Set<string>();
		views.add(viewId);
		this.pendingPicks.set(caller, views);
		let raw: unknown;
		try {
			// userGesture は付けない。付けるとページ（main world）にもユーザー操作の扱いが渡り、
			// 選択を始めた瞬間にクリップボードの書き換えやポップアップを許してしまう。選択は本物の
			// クリック（isTrusted）で行うので要らない
			raw = await target.webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, [{ code: paradisBuildPickScript(nonce, Array.isArray(pins) ? pins : []) }], false);
		} catch {
			// ページの遷移・再読み込み・クラッシュで isolated world ごと消えると reject される。
			// 選択は続けられないので、取り消しとして扱う
			return { kind: 'cancelled' };
		} finally {
			views.delete(viewId);
			if (views.size === 0) {
				this.pendingPicks.delete(caller);
			}
		}
		if (!raw || typeof raw !== 'object') {
			return { kind: 'cancelled' };
		}
		const result = raw as { readonly nonce?: unknown; readonly element?: unknown };
		if (result.nonce !== nonce) {
			return { kind: 'cancelled' };
		}
		const element = paradisClampPickedElement(result.element);
		return element ? { kind: 'picked', element } : { kind: 'cancelled' };
	}

	async cancelPick(viewId: string): Promise<void> {
		const target = this.resolveLive(viewId);
		if (!target) {
			return;
		}
		try {
			await target.webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, [{ code: paradisBuildCancelPickScript() }], false);
		} catch {
			// 遷移中などで流せなくても、仕掛けは遷移と一緒に消えている
		}
	}

	/** そのウィンドウが始めたまま終わっていない選択をすべて取り消す。 */
	async resetPicks(caller: string): Promise<void> {
		const views = [...this.pendingPicks.get(caller) ?? []];
		await Promise.all(views.map(viewId => this.cancelPick(viewId)));
	}

	async setPins(viewId: string, pins: readonly IParadisDesignPin[]): Promise<void> {
		const target = this.resolveLive(viewId);
		if (!target || !Array.isArray(pins)) {
			return;
		}
		try {
			await target.webContents.executeJavaScriptInIsolatedWorld(PARADIS_DESIGN_MODE_WORLD_ID, [{ code: paradisBuildSetPinsScript(pins.slice(0, PARADIS_DESIGN_BUDGET.annotationsMaxPerPage * 2)) }], false);
		} catch {
			// 札は飾りなので、置けなくても何もしない
		}
	}

	async saveImage(png: VSBuffer): Promise<string> {
		const bytes = png?.buffer;
		if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > PARADIS_DESIGN_BUDGET.imageMaxBytes || !paradisIsPng(bytes)) {
			throw new Error('Not a PNG image within the size limit.');
		}
		// 所有者だけが読み書きできる場所にする。すでにあるディレクトリの権限も絞り直す
		// （以前の版や手作業で緩く作られていても、ここで書く画像を他のユーザーから隠す）
		await fs.mkdir(this.imageDirectory, { recursive: true, mode: 0o700 });
		await fs.chmod(this.imageDirectory, 0o700).catch(() => undefined);
		const time = this.now();
		const file = join(this.imageDirectory, `design-${time}-${generateUuid()}.png`);
		// wx: 同名のファイル（や symlink）があれば書かずに失敗させる
		await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
		void this.cleanup();
		return file;
	}

	/** 保存してから一定時間たった画像を消す。 */
	async cleanup(): Promise<void> {
		const now = this.now();
		let names: string[];
		try {
			names = await fs.readdir(this.imageDirectory);
		} catch {
			return;
		}
		for (const name of names) {
			const match = IMAGE_NAME_PATTERN.exec(name);
			const time = Number(match?.groups?.time);
			if (match && Number.isFinite(time) && now - time > IMAGE_TTL_MS) {
				await fs.unlink(join(this.imageDirectory, name)).catch(() => undefined);
			}
		}
	}

	private resolveLive(viewId: string): IParadisDesignModeTarget | undefined {
		if (typeof viewId !== 'string' || viewId.length === 0) {
			return undefined;
		}
		const target = this.resolveTarget(viewId);
		return target && !target.webContents.isDestroyed() ? target : undefined;
	}
}

/**
 * renderer に見せるチャネル。受け付けるのは IParadisDesignModeMainService の5つだけ
 * （`ctx` は IPC が付ける呼び出し元のウィンドウで、選択の後片付けに使う）。
 */
export class ParadisDesignModeChannel implements IServerChannel<string> {

	constructor(private readonly service: ParadisDesignModeMainService) { }

	listen<T>(): Event<T> {
		throw new Error('No events.');
	}

	call<T>(ctx: string, command: string, arg?: unknown[]): Promise<T> {
		const args = Array.isArray(arg) ? arg : [];
		switch (command) {
			case 'pickElement': return this.service.pickElement(ctx, args[0] as string, args[1] as IParadisDesignPin[]) as Promise<T>;
			case 'cancelPick': return this.service.cancelPick(args[0] as string) as Promise<T>;
			case 'setPins': return this.service.setPins(args[0] as string, args[1] as IParadisDesignPin[]) as Promise<T>;
			case 'saveImage': return this.service.saveImage(args[0] as VSBuffer) as Promise<T>;
			case 'resetPicks': return this.service.resetPicks(ctx) as Promise<T>;
		}
		throw new Error(`Unknown command: ${command}`);
	}
}

/** 画像を置くディレクトリ（userData 配下）。 */
export function paradisDesignModeImageDirectory(userDataPath: string): string {
	return join(userDataPath, 'paradis-design-mode', 'images');
}

/** app.ts の PARA-PATCH 点から呼ばれる登録関数。 */
export function paradisRegisterDesignMode(
	channelHost: { registerChannel(channelName: string, channel: IServerChannel<string>): void },
	browserViews: { tryGetBrowserView(id: string): IParadisDesignModeTarget | undefined },
	userDataPath: string,
): IDisposable {
	const service = new ParadisDesignModeMainService(viewId => browserViews.tryGetBrowserView(viewId), paradisDesignModeImageDirectory(userDataPath));
	service.startCleanupSchedule();
	channelHost.registerChannel(PARADIS_DESIGN_MODE_CHANNEL, new ParadisDesignModeChannel(service));
	return service;
}
