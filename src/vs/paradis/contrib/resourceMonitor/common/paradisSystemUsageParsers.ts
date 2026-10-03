/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// システム使用率の測定のうち、OS が出す文字列を数に直す部分（純関数）。
// 読む・実行する側は `node/paradisSystemUsageSampler.ts`。ここを分けているのは、実際の出力例で
// テストするため（Linux の `/proc` は手元の Mac では読めない）。
//
// Linux: `/proc/stat`・`/proc/meminfo`・`/proc/diskstats`・`/proc/net/dev`（追加の依存なし）
// macOS: `vm_stat`・`netstat -ibn`・`ioreg`・`sysctl -n vm.swapusage` を 1 回の `/bin/sh -c` で続けて実行した出力

import { IParadisSystemUsageSample } from './paradisSystemUsage.js';

/** 累計値の 1 回分。使用率・速度は 2 回分の差から出す。 */
export interface IParadisSystemUsageCounters {
	/** 測った時刻(ms)。 */
	readonly at: number;
	/** CPU の累計時間（単位は OS による。比だけを使う）。 */
	readonly cpu?: { readonly busy: number; readonly total: number };
	readonly memUsed?: number;
	readonly memTotal?: number;
	readonly swapUsed?: number;
	readonly swapTotal?: number;
	/** ディスクの読み書きの累計バイト。 */
	readonly diskReadBytes?: number;
	readonly diskWriteBytes?: number;
	/** 受信・送信の累計バイト。 */
	readonly netRxBytes?: number;
	readonly netTxBytes?: number;
	/** ディスク使用率を測るボリュームの使用中・総量(バイト)。 */
	readonly diskUsed?: number;
	readonly diskTotal?: number;
}

/** 速度を出すのに使ってよい、前回からの最長の間隔。これより空いた（スリープ明け等）なら速度は出さない。 */
const MAX_RATE_INTERVAL_MS = 120_000;

function finite(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function percent(used: number | undefined, total: number | undefined): number | undefined {
	if (!finite(used) || !finite(total) || total <= 0) {
		return undefined;
	}
	return Math.round(Math.min(100, Math.max(0, (used / total) * 100)) * 10) / 10;
}

/** 累計の差から毎秒の量を出す。巻き戻り（カウンタの一巡・再起動）は出さない。 */
function rate(previous: number | undefined, next: number | undefined, seconds: number): number | undefined {
	if (!finite(previous) || !finite(next) || seconds <= 0) {
		return undefined;
	}
	const delta = next - previous;
	if (delta < 0) {
		return undefined;
	}
	return Math.round(delta / seconds);
}

/**
 * 前回と今回の累計から 1 点を作る。前回が無い（1 回目）・古すぎるときは、差の要る CPU と速度を省く。
 */
export function paradisComputeSystemUsageSample(previous: IParadisSystemUsageCounters | undefined, next: IParadisSystemUsageCounters): IParadisSystemUsageSample {
	const sample: { -readonly [K in keyof IParadisSystemUsageSample]: IParadisSystemUsageSample[K] } = { t: next.at };
	const mem = percent(next.memUsed, next.memTotal);
	if (mem !== undefined) {
		sample.mem = mem;
	}
	const disk = percent(next.diskUsed, next.diskTotal);
	if (disk !== undefined) {
		sample.disk = disk;
	}
	if (finite(next.swapUsed)) {
		sample.swapUsed = Math.max(0, Math.round(next.swapUsed));
	}
	const elapsedMs = previous !== undefined ? next.at - previous.at : 0;
	if (previous === undefined || elapsedMs <= 0 || elapsedMs > MAX_RATE_INTERVAL_MS) {
		return sample;
	}
	if (previous.cpu !== undefined && next.cpu !== undefined) {
		const total = next.cpu.total - previous.cpu.total;
		const busy = next.cpu.busy - previous.cpu.busy;
		if (total > 0 && busy >= 0) {
			sample.cpu = Math.round(Math.min(100, Math.max(0, (busy / total) * 100)) * 10) / 10;
		}
	}
	const seconds = elapsedMs / 1000;
	const diskRead = rate(previous.diskReadBytes, next.diskReadBytes, seconds);
	const diskWrite = rate(previous.diskWriteBytes, next.diskWriteBytes, seconds);
	const netRx = rate(previous.netRxBytes, next.netRxBytes, seconds);
	const netTx = rate(previous.netTxBytes, next.netTxBytes, seconds);
	if (diskRead !== undefined) {
		sample.diskRead = diskRead;
	}
	if (diskWrite !== undefined) {
		sample.diskWrite = diskWrite;
	}
	if (netRx !== undefined) {
		sample.netRx = netRx;
	}
	if (netTx !== undefined) {
		sample.netTx = netTx;
	}
	return sample;
}

// --- Linux -------------------------------------------------------------------

/**
 * `/proc/stat` の `cpu` 行（全コアの合計）。列は user nice system idle iowait irq softirq steal guest guest_nice。
 * iowait は待ち（使用中に数えない）、steal は他の仮想マシンに取られた時間（このマシンからは使えなかったので使用中に数える）。
 * guest・guest_nice は user・nice に既に含まれるので足さない。
 */
export function paradisParseProcStat(text: string): { readonly busy: number; readonly total: number } | undefined {
	for (const line of text.split('\n')) {
		if (!line.startsWith('cpu ')) {
			continue;
		}
		const values = line.trim().split(/\s+/).slice(1).map(Number);
		if (values.length < 4 || values.slice(0, 4).some(value => !Number.isFinite(value))) {
			return undefined;
		}
		const at = (index: number) => Number.isFinite(values[index]) ? values[index] : 0;
		const idle = at(3) + at(4);
		const busy = at(0) + at(1) + at(2) + at(5) + at(6) + at(7);
		return { busy, total: busy + idle };
	}
	return undefined;
}

/**
 * `/proc/meminfo`。使用中は MemTotal - MemAvailable（MemAvailable の無い古いカーネルでは Free + Buffers + Cached を引く）。
 */
export function paradisParseProcMeminfo(text: string): { readonly memTotal?: number; readonly memUsed?: number; readonly swapTotal?: number; readonly swapUsed?: number } {
	const values = new Map<string, number>();
	for (const line of text.split('\n')) {
		const match = /^(?<key>[A-Za-z0-9_()]+):\s+(?<value>\d+)(?:\s+kB)?/.exec(line);
		if (match?.groups) {
			values.set(match.groups.key, Number(match.groups.value) * 1024);
		}
	}
	const memTotal = values.get('MemTotal');
	const available = values.get('MemAvailable')
		?? (values.has('MemFree') ? (values.get('MemFree') ?? 0) + (values.get('Buffers') ?? 0) + (values.get('Cached') ?? 0) : undefined);
	const swapTotal = values.get('SwapTotal');
	const swapFree = values.get('SwapFree');
	return {
		...(memTotal !== undefined ? { memTotal } : {}),
		...(memTotal !== undefined && available !== undefined ? { memUsed: Math.max(0, memTotal - available) } : {}),
		...(swapTotal !== undefined ? { swapTotal } : {}),
		...(swapTotal !== undefined && swapFree !== undefined ? { swapUsed: Math.max(0, swapTotal - swapFree) } : {}),
	};
}

/** 物理ディスクでないもの（ループ・RAM・device-mapper・ソフトウェア RAID・光学ドライブ等）。足すと二重に数える。 */
const LINUX_VIRTUAL_DISK = /^(?:loop|ram|zram|dm-|md|sr|fd|nbd|rbd)/;

/**
 * `/proc/diskstats` の読み書きセクタ数（1 セクタ 512 バイト固定）の合計。物理ディスク全体だけを足す
 * （パーティションは親のディスクに含まれるので、足すと二重に数える）。
 */
export function paradisParseProcDiskstats(text: string): { readonly readBytes: number; readonly writeBytes: number } | undefined {
	const rows: { name: string; read: number; write: number }[] = [];
	for (const line of text.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 10) {
			continue;
		}
		const name = fields[2];
		const read = Number(fields[5]);
		const write = Number(fields[9]);
		if (!name || !Number.isFinite(read) || !Number.isFinite(write)) {
			continue;
		}
		rows.push({ name, read, write });
	}
	if (rows.length === 0) {
		return undefined;
	}
	const names = new Set(rows.map(row => row.name));
	const isPartition = (name: string) => paradisIsLinuxPartition(name, names);
	let readBytes = 0;
	let writeBytes = 0;
	for (const row of rows) {
		if (LINUX_VIRTUAL_DISK.test(row.name) || isPartition(row.name)) {
			continue;
		}
		readBytes += row.read * 512;
		writeBytes += row.write * 512;
	}
	return { readBytes, writeBytes };
}

/**
 * パーティションか（親のディスクが一覧に居るときだけ）。親の名前が数字で終わるデバイス（`nvme0n1`・`mmcblk0`）の
 * パーティションは `p<番号>`（`nvme0n1p1`）、文字で終わるデバイス（`sda`）は `<番号>`（`sda1`）が付く。
 * `nvme0n10` は `nvme0n1` の後ろに `0` が付いただけの別のディスクなので、パーティションにしない。
 */
export function paradisIsLinuxPartition(name: string, names: ReadonlySet<string>): boolean {
	for (let cut = name.length - 1; cut > 0; cut--) {
		const base = name.slice(0, cut);
		if (!names.has(base)) {
			continue;
		}
		const rest = name.slice(cut);
		if (/\d$/.test(base) ? /^p\d+$/.test(rest) : /^\d+$/.test(rest)) {
			return true;
		}
	}
	return false;
}

/**
 * 帯域に数えないインターフェース（Linux・macOS 共通）。足すと同じ通信を二重に数えるもの:
 *  - ループバック（lo）
 *  - トンネル・VPN（tun・tap・utun・wg・tailscale・zt・ipsec・ppp・gif・stf。中身は物理インターフェースでも数える）
 *  - 束ね・ブリッジ（bond・team・bridge・br0・br-・virbr。メンバーと二重になる）
 *  - コンテナ（docker・veth・cni・flannel・cali・vxlan・tunl・kube-ipvs）、ifb（入力の整形用の写し）
 *  - macOS の直結・内部用（awdl・llw・anpi）
 *  - VLAN（`eth0.100` のように `.` を含む名前。親のインターフェースでも数える）
 * macOS の `netstat` が落ちているインターフェースに付ける末尾の `*` は外して判定する。
 */
const VIRTUAL_INTERFACE = /^(?:lo|tun|tap|utun|wg|tailscale|zt|ipsec|ppp|gif|stf|bond|team|bridge|br\d|br-|virbr|docker|veth|cni|flannel|cali|vxlan|tunl|kube-ipvs|ifb|awdl|llw|anpi)/;

export function paradisIsVirtualInterface(name: string): boolean {
	const bare = name.replace(/\*$/, '');
	return bare.includes('.') || VIRTUAL_INTERFACE.test(bare);
}

/** `/proc/net/dev` の受信・送信バイトの合計。 */
export function paradisParseProcNetDev(text: string): { readonly rxBytes: number; readonly txBytes: number } | undefined {
	let rxBytes = 0;
	let txBytes = 0;
	let found = false;
	for (const line of text.split('\n')) {
		const colon = line.indexOf(':');
		if (colon < 0) {
			continue;
		}
		const name = line.slice(0, colon).trim();
		const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
		if (!name || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) {
			continue;
		}
		found = true;
		if (paradisIsVirtualInterface(name)) {
			continue;
		}
		rxBytes += fields[0];
		txBytes += fields[8];
	}
	return found ? { rxBytes, txBytes } : undefined;
}

// --- macOS -------------------------------------------------------------------

/** macOS の 1 回の測定で区切りに出す行。 */
export const PARADIS_DARWIN_SECTION_MARKER = '@@PARADIS_SYSTEM_USAGE@@';

/**
 * macOS で 5 秒ごとに実行するスクリプト。4 つのコマンドを 1 つの `/bin/sh` で続けて実行し、区切りの行で分ける
 * （コマンドごとにプロセスを起こすと 5 秒ごとに 4 つ起きる）。失敗したコマンドは空の節になるだけで、残りは読める。
 */
export const PARADIS_DARWIN_SYSTEM_USAGE_SCRIPT = [
	'/usr/bin/vm_stat',
	`echo ${PARADIS_DARWIN_SECTION_MARKER}`,
	'/usr/sbin/netstat -ibn',
	`echo ${PARADIS_DARWIN_SECTION_MARKER}`,
	// -t で各ディスクの親の並びも出す（ディスクイメージを見分けるため）
	'/usr/sbin/ioreg -c IOBlockStorageDriver -r -t -k Statistics -d 1 -w 0',
	`echo ${PARADIS_DARWIN_SECTION_MARKER}`,
	'/usr/sbin/sysctl -n vm.swapusage',
].join('; ');

export function paradisSplitDarwinSystemUsageOutput(output: string): { readonly vmStat: string; readonly netstat: string; readonly ioreg: string; readonly swap: string } {
	const [vmStat = '', netstat = '', ioreg = '', swap = ''] = output.split(`${PARADIS_DARWIN_SECTION_MARKER}\n`);
	return { vmStat, netstat, ioreg, swap };
}

/**
 * `vm_stat`。使用中は active + wired + compressed（compressor が占めているページ。アクティビティモニタの
 * 「使用済みメモリ」に近い）。ページの大きさは 1 行目から読む（Apple Silicon は 16KB、Intel は 4KB）。
 */
export function paradisParseVmStat(text: string): number | undefined {
	const pageSizeMatch = /page size of (?<size>\d+) bytes/.exec(text);
	const pageSize = pageSizeMatch?.groups ? Number(pageSizeMatch.groups.size) : undefined;
	if (pageSize === undefined || !Number.isFinite(pageSize) || pageSize <= 0) {
		return undefined;
	}
	const pages = (label: string) => {
		const match = new RegExp(`^${label}:\\s+(?<count>\\d+)\\.?\\s*$`, 'm').exec(text);
		return match?.groups ? Number(match.groups.count) : undefined;
	};
	const active = pages('Pages active');
	const wired = pages('Pages wired down');
	const compressed = pages('Pages occupied by compressor');
	if (active === undefined || wired === undefined) {
		return undefined;
	}
	return (active + wired + (compressed ?? 0)) * pageSize;
}

/**
 * `netstat -ibn` の受信・送信バイト。`<Link#n>` の行（インターフェースごとに 1 行）だけを足す。
 * Address の列が空の行があるので、数の列は右から数える（… Ibytes Opkts Oerrs Obytes Coll）。
 */
export function paradisParseNetstatIbn(text: string): { readonly rxBytes: number; readonly txBytes: number } | undefined {
	let rxBytes = 0;
	let txBytes = 0;
	let found = false;
	const seen = new Set<string>();
	for (const line of text.split('\n')) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 9 || !fields[2]?.startsWith('<Link#')) {
			continue;
		}
		const name = fields[0];
		const ibytes = Number(fields[fields.length - 5]);
		const obytes = Number(fields[fields.length - 2]);
		if (!Number.isFinite(ibytes) || !Number.isFinite(obytes)) {
			continue;
		}
		found = true;
		if (seen.has(name) || paradisIsVirtualInterface(name)) {
			continue;
		}
		seen.add(name);
		rxBytes += ibytes;
		txBytes += obytes;
	}
	return found ? { rxBytes, txBytes } : undefined;
}

/** ディスクイメージ（DiskImages2 の AppleDiskImageDevice、旧来の IOHDIXController 配下）。中身の読み書きは実ディスクでも数える。 */
const DISK_IMAGE_CLASS = /<class (?:AppleDiskImage|IOHDIX)/;

/**
 * `ioreg -c IOBlockStorageDriver -r -t -k Statistics` の全ディスクの読み書きの累計バイト。
 * 1 台ぶんの塊は行頭の `+-o` から始まり、`-t` で親の並び（Root から）が付く。親にディスクイメージがあれば数えない。
 */
export function paradisParseIoregDiskStats(text: string): { readonly readBytes: number; readonly writeBytes: number } | undefined {
	let readBytes = 0;
	let writeBytes = 0;
	let found = false;
	const blocks = text.split(/\n(?=\+-o )/);
	for (const block of blocks) {
		if (DISK_IMAGE_CLASS.test(block)) {
			found = found || /"Bytes \((?:Read|Write)\)"=\d+/.test(block);
			continue;
		}
		const counted = paradisSumIoregBytes(block);
		if (counted !== undefined) {
			found = true;
			readBytes += counted.readBytes;
			writeBytes += counted.writeBytes;
		}
	}
	return found ? { readBytes, writeBytes } : undefined;
}

function paradisSumIoregBytes(text: string): { readonly readBytes: number; readonly writeBytes: number } | undefined {
	let readBytes = 0;
	let writeBytes = 0;
	let found = false;
	for (const match of text.matchAll(/"Bytes \((?<kind>Read|Write)\)"=(?<value>\d+)/g)) {
		const value = Number(match.groups?.value);
		if (!Number.isFinite(value)) {
			continue;
		}
		found = true;
		if (match.groups?.kind === 'Read') {
			readBytes += value;
		} else {
			writeBytes += value;
		}
	}
	return found ? { readBytes, writeBytes } : undefined;
}

const SIZE_UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl -n vm.swapusage`（例 `total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)`）。 */
export function paradisParseSwapUsage(text: string): { readonly swapTotal: number; readonly swapUsed: number } | undefined {
	const read = (label: string) => {
		const match = new RegExp(`${label}\\s*=\\s*(?<value>[\\d.]+)(?<unit>[BKMGT])?`).exec(text);
		if (!match?.groups) {
			return undefined;
		}
		const value = Number(match.groups.value);
		const unit = SIZE_UNITS[match.groups.unit ?? 'B'] ?? 1;
		return Number.isFinite(value) ? Math.round(value * unit) : undefined;
	};
	const swapTotal = read('total');
	const swapUsed = read('used');
	return swapTotal !== undefined && swapUsed !== undefined ? { swapTotal, swapUsed } : undefined;
}
