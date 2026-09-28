/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { IProductConfiguration } from '../../../base/common/product.js';

/**
 * Product fields that decide which update channel a build follows.
 */
export type ParadisUpdateChannelProduct = Pick<IProductConfiguration, 'quality' | 'paradisUpdateChannel'>;

/**
 * Channel names end up in the update server's URL path (`/api/update/{platform}/{channel}/{commit}`
 * and `/api/changelog/{channel}`), so anything that isn't a plain lowercase identifier is ignored.
 */
const PARADIS_UPDATE_CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/;

function normalizeParadisUpdateChannel(value: string | undefined): string | undefined {
	const channel = value?.trim();
	return channel && PARADIS_UPDATE_CHANNEL_PATTERN.test(channel) ? channel : undefined;
}

/**
 * Resolves the update channel the feed and the in-app changelog are fetched from.
 *
 * Precedence is "user setting > channel stamped at build time > product quality":
 * - `configuredChannel` is reserved for a future `paradis.update.channel` setting and is not wired yet.
 * - `product.paradisUpdateChannel` is stamped into product.json by build/gulpfile.vscode.ts only for
 *   beta builds (env `PARA_UPDATE_CHANNEL`), so beta testers keep following the beta feed while the
 *   build otherwise behaves exactly like stable (`quality` stays `stable`).
 * - Stable builds carry no stamp and fall back to `product.quality`, which is the upstream behavior.
 */
export function resolveParadisUpdateChannel(product: ParadisUpdateChannelProduct, configuredChannel?: string): string | undefined {
	return normalizeParadisUpdateChannel(configuredChannel)
		?? normalizeParadisUpdateChannel(product.paradisUpdateChannel)
		?? product.quality;
}

/**
 * URL of the changelog markdown for this build's update channel on the self-hosted update server
 * (cloudflare/update-server `GET /api/changelog/:quality`), or `undefined` without an update URL.
 */
export function getParadisChangelogFeedUrl(product: ParadisUpdateChannelProduct & Pick<IProductConfiguration, 'updateUrl'>, configuredChannel?: string): string | undefined {
	if (!product.updateUrl) {
		return undefined;
	}
	return `${product.updateUrl}/api/changelog/${resolveParadisUpdateChannel(product, configuredChannel) ?? 'stable'}`;
}
