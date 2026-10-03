/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// モバイルから上げた添付画像を、後から（別の端末・開き直した会話で）スマホへ返す口（fs.attachment.v1）。
//
// - fs の `attachment` { name, variant: 'thumb' | 'full', responseEncoding? }
//   - `name` は置き場（<userData>/paraMobileUploads/）の直下のファイル名だけ。パスは受け取らない
//   - `thumb` は長辺 512px の JPEG に縮めて返す。縮められない（形式が読めない・大きすぎる）ときは `{ error, code: 'no-thumbnail' }`
//   - `full` は置き場のファイルをそのまま返す
// - `responseEncoding: 'fs-binary-v1'` なら fs のバイナリ応答（種類は media）、それ以外は `{ t: 'attachment', data（base64）, size, mediaType }`。
//   `size` はサムネイルの応答でも置き場のファイル（原寸）の大きさ
// - 置き場に無い・外を指す・読めない・読んでいる間に差し替えられたときは `{ error, code: 'missing' }`、接続先の置き場を
//   確かめられないときは `{ error, code: 'remote-unavailable' }`、それ以外の想定していない失敗は `{ error, code: 'other' }`
//   （文は固定。パスや例外の文は入れない）
// - サムネイルは読み込み・照合・縮小を 1 本ずつの列で行い（待てるのは 8 件まで。超えたら `other`）、
//   置き場・実体・大きさ・更新時刻をキーにした LRU に控える
//
// 置き場はアップロードと同じ決め方（SSH 接続中は接続先。`paradisMobileUploadHome.ts`）。検査は `paradisMobileAttachment.ts`。

import { Sequencer } from '../../../../base/common/async.js';
import { encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IRemoteAgentService } from '../../../../workbench/services/remote/common/remoteAgentService.js';
import {
	PARADIS_MOBILE_ATTACHMENT_READ_LIMIT,
	PARADIS_MOBILE_ATTACHMENT_THUMB_QUEUE_LIMIT,
	type ParadisMobileAttachmentResolution,
	PARADIS_MOBILE_ATTACHMENT_THUMB_MAX_PIXELS,
	PARADIS_MOBILE_UPLOADS_DIRECTORY,
	ParadisMobileThumbnailCache,
	paradisMobileAttachmentThumbSize,
	paradisParseMobileAttachmentVariant,
	paradisReadImageDimensions,
	paradisResolveMobileAttachment,
	paradisSameMobileAttachment,
	paradisSniffImageMediaType,
} from '../common/paradisMobileAttachment.js';
import { paradisEncodeNegotiatedBinaryFsResponse } from '../common/paradisMobileFileResponse.js';
import { registerParadisMobileRequestHandler } from './paradisMobileRequestHandlers.js';
import { paradisResolveMobileUploadHome } from './paradisMobileUploadHome.js';

function tooLargeReply(): object {
	return { error: localize('paradis.mobile.attachment.tooLarge', "This image exceeds the transfer limit ({0} MB).", PARADIS_MOBILE_ATTACHMENT_READ_LIMIT / 1024 / 1024), code: 'too-large' };
}

/** サムネイルの JPEG の品質。 */
const THUMB_QUALITY = 0.8;

/**
 * 長辺 512px の JPEG に縮める。読めない形式（HEIC など）・画素数が多すぎる画像は undefined。
 * 透過のある画像は白の上に置く（JPEG に透過は無い）。
 */
export async function paradisCreateMobileAttachmentThumbnail(bytes: Uint8Array): Promise<Uint8Array | undefined> {
	// 展開する前にヘッダーの縦横で画素数を確かめる（小さなファイルが巨大な画像に展開されるのを防ぐ）
	const dimensions = paradisReadImageDimensions(bytes);
	if (dimensions === undefined || dimensions.width * dimensions.height > PARADIS_MOBILE_ATTACHMENT_THUMB_MAX_PIXELS) {
		return undefined;
	}
	let bitmap: ImageBitmap;
	try {
		// 縮める寸法は向き（EXIF）を当てた後の縦横から決めるので、ここでは原寸で展開する
		bitmap = await createImageBitmap(new Blob([bytes.slice()]));
	} catch {
		return undefined;
	}
	try {
		const target = paradisMobileAttachmentThumbSize(bitmap.width, bitmap.height);
		const canvas = new OffscreenCanvas(target.width, target.height);
		const context = canvas.getContext('2d');
		if (!context) {
			return undefined;
		}
		context.fillStyle = '#ffffff';
		context.fillRect(0, 0, target.width, target.height);
		context.imageSmoothingQuality = 'high';
		context.drawImage(bitmap, 0, 0, target.width, target.height);
		const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
		return new Uint8Array(await blob.arrayBuffer());
	} catch {
		return undefined;
	} finally {
		bitmap.close();
	}
}

/**
 * サムネイルは、読み込み・照合・縮小までを 1 本ずつの列で行う（大きな画像を同時に読んで展開し、renderer の
 * メモリを使い切らない）。列で待てるのは {@link PARADIS_MOBILE_ATTACHMENT_THUMB_QUEUE_LIMIT} 件までで、超えた分は
 * `other` で断る（待っている要求がそれぞれ原寸の中身を抱えたまま積み上がらないよう、中身は列の中で読む）。
 */
const thumbnailSequencer = new Sequencer();
const thumbnailCache = new ParadisMobileThumbnailCache();
let queuedThumbnails = 0;

function missingReply(): object {
	return { error: localize('paradis.mobile.attachment.missing', "This image is no longer on the PC."), code: 'missing' };
}

function failedReply(): object {
	return { error: localize('paradis.mobile.attachment.failed', "This image could not be read."), code: 'other' };
}

type ReadOutcome = { readonly kind: 'ok'; readonly bytes: Uint8Array } | { readonly kind: 'reply'; readonly body: object };

/** 置き場のファイルを読み、読んでいる間に差し替えられていない（実体のパス・大きさ・更新時刻が同じ）ことを確かめる。 */
async function readVerified(fileService: Pick<IFileService, 'readFile' | 'realpath' | 'stat'>, directory: URI, name: string, resolved: ParadisMobileAttachmentResolution & { readonly kind: 'ok' }): Promise<ReadOutcome> {
	let content: Uint8Array;
	try {
		// 検査の後に伸びていても上限より先は読まない
		content = (await fileService.readFile(resolved.uri, { length: PARADIS_MOBILE_ATTACHMENT_READ_LIMIT + 1 })).value.buffer;
	} catch {
		return { kind: 'reply', body: missingReply() };
	}
	if (content.byteLength > PARADIS_MOBILE_ATTACHMENT_READ_LIMIT) {
		return { kind: 'reply', body: tooLargeReply() };
	}
	const after = await paradisResolveMobileAttachment(fileService, directory, name);
	if (!paradisSameMobileAttachment(resolved, after) || content.byteLength !== resolved.size) {
		return { kind: 'reply', body: missingReply() };
	}
	return { kind: 'ok', bytes: content };
}

/** サムネイルを列の中で読み・確かめ・縮める（控えにあればそれ）。列が埋まっていたら `other`。 */
function thumbnailFor(fileService: Pick<IFileService, 'readFile' | 'realpath' | 'stat'>, directory: URI, name: string, resolved: ParadisMobileAttachmentResolution & { readonly kind: 'ok' }): Promise<ReadOutcome> {
	const key = ParadisMobileThumbnailCache.keyOf(directory, resolved);
	const cached = thumbnailCache.get(key);
	if (cached !== undefined) {
		return Promise.resolve({ kind: 'ok', bytes: cached });
	}
	if (queuedThumbnails >= PARADIS_MOBILE_ATTACHMENT_THUMB_QUEUE_LIMIT) {
		return Promise.resolve({ kind: 'reply', body: failedReply() });
	}
	queuedThumbnails++;
	return thumbnailSequencer.queue(async (): Promise<ReadOutcome> => {
		try {
			const again = thumbnailCache.get(key);
			if (again !== undefined) {
				return { kind: 'ok', bytes: again };
			}
			const read = await readVerified(fileService, directory, name, resolved);
			if (read.kind !== 'ok') {
				return read;
			}
			const thumbnail = await paradisCreateMobileAttachmentThumbnail(read.bytes);
			if (thumbnail === undefined) {
				return { kind: 'reply', body: { error: localize('paradis.mobile.attachment.noThumbnail', "A preview of this image cannot be created."), code: 'no-thumbnail' } };
			}
			thumbnailCache.set(key, thumbnail);
			return { kind: 'ok', bytes: thumbnail };
		} finally {
			queuedThumbnails--;
		}
	});
}

registerParadisMobileRequestHandler('fs', 'attachment', {
	handle(accessor, request, context) {
		const fileService = accessor.get(IFileService);
		const environmentService = accessor.get(IEnvironmentService);
		const remoteAgentService = accessor.get(IRemoteAgentService);
		const variant = paradisParseMobileAttachmentVariant(request.variant);
		if (variant === undefined || typeof request.name !== 'string') {
			context.reply({ error: 'invalid attachment request' });
			return;
		}
		const name = request.name;
		return (async () => {
			let directory: URI;
			try {
				const home = await paradisResolveMobileUploadHome(environmentService, remoteAgentService);
				directory = joinPath(home.userData, PARADIS_MOBILE_UPLOADS_DIRECTORY);
			} catch {
				context.reply({ error: localize('paradis.mobile.attachment.remoteUnavailable', "The attachment folder on the remote host is not available right now."), code: 'remote-unavailable' });
				return;
			}
			const resolved = await paradisResolveMobileAttachment(fileService, directory, name);
			if (resolved.kind === 'invalid') {
				context.reply({ error: 'invalid attachment name' });
				return;
			}
			if (resolved.kind === 'missing') {
				context.reply(missingReply());
				return;
			}
			if (resolved.kind === 'tooLarge') {
				context.reply(tooLargeReply());
				return;
			}
			const outcome = variant === 'thumb'
				? await thumbnailFor(fileService, directory, name, resolved)
				: await readVerified(fileService, directory, name, resolved);
			if (outcome.kind === 'reply') {
				context.reply(outcome.body);
				return;
			}
			const bytes = outcome.bytes;
			const mediaType = variant === 'thumb' ? 'image/jpeg' : paradisSniffImageMediaType(bytes);
			// `size` はどちらの形でも置き場のファイル（原寸）の大きさ（アプリが transcript の画像と照合する）
			const binary = paradisEncodeNegotiatedBinaryFsResponse(request.responseEncoding, 'media', request.id, resolved.size, bytes);
			if (binary !== undefined) {
				context.sendBytes(binary);
				return;
			}
			context.reply({ t: 'attachment', data: encodeBase64(VSBuffer.wrap(bytes)), size: resolved.size, ...(mediaType !== undefined ? { mediaType } : {}) });
		})().catch(() => {
			// 想定していない失敗は固定の文で返す（パスや例外の文を応答に入れない）
			context.reply(failedReply());
		});
	},
});
