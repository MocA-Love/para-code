/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 実際の出力の形（数とインターフェース名は書き換え、MAC アドレス・IP アドレスは例示用の値にしてある）で、
// OS の出力を数に直す部分を確かめる。

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	PARADIS_DARWIN_SECTION_MARKER,
	paradisComputeSystemUsageSample,
	paradisParseIoregDiskStats,
	paradisParseNetstatIbn,
	paradisParseProcDiskstats,
	paradisParseProcMeminfo,
	paradisParseProcNetDev,
	paradisParseProcStat,
	paradisParseSwapUsage,
	paradisParseVmStat,
	paradisSplitDarwinSystemUsageOutput,
} from '../../common/paradisSystemUsageParsers.js';

const PROC_STAT = [
	'cpu  4705 356 584 3699 23 0 23 100 0 0',
	'cpu0 1393280 32966 572056 13343292 6130 0 17875 0 23933 0',
	'intr 114930548 113199788 3 0 5 263 0 4 [... 220 more]',
	'ctxt 1990473',
	'btime 1062191376',
	'processes 2915',
	'procs_running 1',
	'procs_blocked 0',
].join('\n');

const PROC_MEMINFO = [
	'MemTotal:       16303428 kB',
	'MemFree:          823304 kB',
	'MemAvailable:    9873104 kB',
	'Buffers:          412300 kB',
	'Cached:          8235904 kB',
	'SwapCached:         1024 kB',
	'Active:          6542100 kB',
	'SwapTotal:       2097148 kB',
	'SwapFree:        1572860 kB',
	'HugePages_Total:       0',
	'Hugepagesize:       2048 kB',
].join('\n');

const PROC_DISKSTATS = [
	'   7       0 loop0 52 0 2106 13 0 0 0 0 0 40 13 0 0 0 0 0 0',
	'   8       0 sda 160374 49632 9364582 54412 251031 286613 13063232 384100 0 309924 446092 0 0 0 0 9312 7579',
	'   8       1 sda1 159982 49632 9349262 54312 250966 286613 13063232 384064 0 309864 438376 0 0 0 0 0 0',
	' 259       0 nvme0n1 1000 0 2000 10 3000 0 4000 20 0 30 30 0 0 0 0 0 0',
	' 259       1 nvme0n1p1 900 0 1900 10 2900 0 3900 20 0 30 30 0 0 0 0 0 0',
	' 253       0 dm-0 500 0 999 1 500 0 999 1 0 2 2 0 0 0 0 0 0',
	// nvme0n10 は nvme0n1 の後ろに 0 が付いただけの別のディスク（パーティションではない）
	' 259       2 nvme0n10 1 0 100 1 1 0 200 1 0 2 2 0 0 0 0 0 0',
	' 259       3 nvme0n10p1 1 0 90 1 1 0 190 1 0 2 2 0 0 0 0 0 0',
	' 179       0 mmcblk0 1 0 10 1 1 0 20 1 0 2 2 0 0 0 0 0 0',
	' 179       1 mmcblk0p1 1 0 9 1 1 0 19 1 0 2 2 0 0 0 0 0 0',
].join('\n');

const PROC_NET_DEV = [
	'Inter-|   Receive                                                |  Transmit',
	' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
	'    lo: 9999999   99999    0    0    0     0          0         0  9999999   99999    0    0    0     0       0          0',
	'  eth0: 1500000    3000    0    0    0     0          0         0   250000    2000    0    0    0     0       0          0',
	'docker0: 700000     100    0    0    0     0          0         0   700000     100    0    0    0     0       0          0',
	'vethab12: 1234      10    0    0    0     0          0         0     1234      10    0    0    0     0       0          0',
	'  wlan0:  500000     900    0    0    0     0          0         0    50000     800    0    0    0     0       0          0',
	// トンネル・VPN・束ね・VLAN は物理インターフェースと二重になるので数えない
	...['tun0', 'tap0', 'wg0', 'tailscale0', 'ztabcdef', 'ipsec0', 'ppp0', 'bond0', 'team0', 'ifb0', 'br0', 'eth0.100'].map(name => `${name}: 7777 1 0 0 0 0 0 0 8888 1 0 0 0 0 0 0`),
].join('\n');

const VM_STAT = [
	'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
	'Pages free:                                    12926.',
	'Pages active:                                 528291.',
	'Pages inactive:                               524381.',
	'Pages speculative:                              2553.',
	'Pages throttled:                                   0.',
	'Pages wired down:                             406290.',
	'Pages purgeable:                                4488.',
	'"Translation faults":                     6770990477.',
	'Pages stored in compressor:                  1162036.',
	'Pages occupied by compressor:                 582223.',
	'Swapins:                                   307091722.',
].join('\n');

const NETSTAT_IBN = [
	'Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll',
	'lo0        16384 <Link#1>                      135868432     0 270876515245 135868432     0 270876515245     0',
	'lo0        16384 127           127.0.0.1       135868432     - 270876515245 135868432     - 270876515245     -',
	'gif0*      1280  <Link#2>                             0     0          0        0     0          0     0',
	'anpi0      1500  <Link#5>    02:00:00:00:00:01        5     0        500        5     0        500     0',
	'en14       1500  <Link#13>   02:00:00:00:00:02 71779550     0 67350896364 27689513     0 20358958405     0',
	'en14       1500  192.168.0     192.168.0.10   71779550     - 67350896364 27689513     - 20358958405     -',
	'bridge0    1500  <Link#17>   02:00:00:00:00:03      100     0      10000      100     0      10000     0',
	'en0        1500  <Link#16>   02:00:00:00:00:04  1611891     0  403573052   319186     0   65463036     0',
	'utun3      1380  <Link#21>                          42     0       4200       42     0       4200     0',
	'bond0      1500  <Link#22>   02:00:00:00:00:05      100     0       7777      100     0       8888     0',
	'vlan0.10   1500  <Link#23>   02:00:00:00:00:06      100     0       7777      100     0       8888     0',
	'ppp0       1500  <Link#24>                          100     0       7777      100     0       8888     0',
].join('\n');

const IOREG = [
	'+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100000b4e, registered, matched, active, busy 0 (0 ms), retain 6>',
	'    {',
	'      "IOClass" = "IOBlockStorageDriver"',
	'      "Statistics" = {"Operations (Write)"=0,"Latency Time (Write)"=0,"Bytes (Read)"=0,"Errors (Write)"=0,"Bytes (Write)"=0,"Operations (Read)"=0}',
	'    }',
	'',
	'+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100000936, registered, matched, active, busy 0 (165 ms), retain 8>',
	'    {',
	'      "IOClass" = "IOBlockStorageDriver"',
	'      "Statistics" = {"Operations (Write)"=165807382,"Latency Time (Write)"=0,"Bytes (Read)"=15230596993024,"Errors (Write)"=0,"Total Time (Read)"=282489049252537,"Bytes (Write)"=6288013434880,"Operations (Read)"=481999871}',
	'    }',
	'',
	'+-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100001a50, registered, matched, active, busy 0 (27 ms), retain 8>',
	'    {',
	'      "Statistics" = {"Operations (Write)"=0,"Bytes (Read)"=150510395904,"Bytes (Write)"=0,"Operations (Read)"=7524490}',
	'    }',
	'',
	// -t の出力: Root からの親の並びが付く。親にディスクイメージ（AppleDiskImageDevice）があるものは数えない
	'+-o Root  <class IORegistryEntry, id 0x100000100, retain 37>',
	'  +-o AppleDiskImagesController  <class AppleDiskImagesController, id 0x100001000, registered, matched, active, busy 0 (0 ms), retain 9>',
	'    +-o AppleDiskImageDevice  <class AppleDiskImageDevice, id 0x100001001, registered, matched, active, busy 0 (0 ms), retain 9>',
	'      +-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100001002, registered, matched, active, busy 0 (0 ms), retain 8>',
	'            "Statistics" = {"Bytes (Read)"=999999,"Bytes (Write)"=888888}',
	'+-o Root  <class IORegistryEntry, id 0x100000100, retain 37>',
	'  +-o IOHDIXController  <class IOHDIXController, id 0x100002000, registered, matched, active, busy 0 (0 ms), retain 5>',
	'    +-o IOBlockStorageDriver  <class IOBlockStorageDriver, id 0x100002002, registered, matched, active, busy 0 (0 ms), retain 8>',
	'          "Statistics" = {"Bytes (Read)"=777777,"Bytes (Write)"=666666}',
].join('\n');

const SWAPUSAGE = 'total = 20480.00M  used = 18933.31M  free = 1546.69M  (encrypted)';

suite('ParadisSystemUsageParsers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('reads the Linux /proc files', () => {
		assert.deepStrictEqual({
			stat: paradisParseProcStat(PROC_STAT),
			statMissing: paradisParseProcStat('intr 1 2 3'),
			meminfo: paradisParseProcMeminfo(PROC_MEMINFO),
			meminfoWithoutAvailable: paradisParseProcMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB'),
			diskstats: paradisParseProcDiskstats(PROC_DISKSTATS),
			netDev: paradisParseProcNetDev(PROC_NET_DEV),
			netDevEmpty: paradisParseProcNetDev(''),
		}, {
			// busy = user + nice + system + irq + softirq + steal、待ち = idle + iowait
			stat: { busy: 4705 + 356 + 584 + 0 + 23 + 100, total: 4705 + 356 + 584 + 0 + 23 + 100 + 3699 + 23 },
			statMissing: undefined,
			meminfo: { memTotal: 16303428 * 1024, memUsed: (16303428 - 9873104) * 1024, swapTotal: 2097148 * 1024, swapUsed: (2097148 - 1572860) * 1024 },
			meminfoWithoutAvailable: { memTotal: 1000 * 1024, memUsed: 600 * 1024 },
			// sda・nvme0n1・nvme0n10・mmcblk0 だけを足す（loop・dm・パーティションは除く）
			diskstats: { readBytes: (9364582 + 2000 + 100 + 10) * 512, writeBytes: (13063232 + 4000 + 200 + 20) * 512 },
			// lo・docker0・veth・トンネル・束ね・VLAN を除いた eth0 と wlan0
			netDev: { rxBytes: 1500000 + 500000, txBytes: 250000 + 50000 },
			netDevEmpty: undefined,
		});
	});

	test('reads the macOS command outputs from one shell run', () => {
		const output = [VM_STAT, NETSTAT_IBN, IOREG, SWAPUSAGE].join(`\n${PARADIS_DARWIN_SECTION_MARKER}\n`) + '\n';
		const sections = paradisSplitDarwinSystemUsageOutput(output);
		assert.deepStrictEqual({
			vmStat: paradisParseVmStat(sections.vmStat),
			netstat: paradisParseNetstatIbn(sections.netstat),
			ioreg: paradisParseIoregDiskStats(sections.ioreg),
			swap: paradisParseSwapUsage(sections.swap),
			swapGigabytes: paradisParseSwapUsage('total = 2.00G  used = 0.00M  free = 2.00G  (encrypted)'),
			// コマンドが失敗して節が空でも、ほかの節は読める
			missing: paradisSplitDarwinSystemUsageOutput(`${PARADIS_DARWIN_SECTION_MARKER}\n${PARADIS_DARWIN_SECTION_MARKER}\n`),
			vmStatBroken: paradisParseVmStat('Pages active: 1.'),
			ioregEmpty: paradisParseIoregDiskStats(''),
		}, {
			// active + wired + compressor のページ × 16KB
			vmStat: (528291 + 406290 + 582223) * 16384,
			// lo0・gif0・anpi0・bridge0・utun3・bond0・vlan0.10・ppp0 を除き、en14 の IP 行は数えない
			netstat: { rxBytes: 67350896364 + 403573052, txBytes: 20358958405 + 65463036 },
			// ディスクイメージ 2 台（DiskImages2 と旧来の IOHDIX）は数えない
			ioreg: { readBytes: 15230596993024 + 150510395904, writeBytes: 6288013434880 },
			swap: { swapTotal: Math.round(20480 * 1024 ** 2), swapUsed: Math.round(18933.31 * 1024 ** 2) },
			swapGigabytes: { swapTotal: 2 * 1024 ** 3, swapUsed: 0 },
			missing: { vmStat: '', netstat: '', ioreg: '', swap: '' },
			vmStatBroken: undefined,
			ioregEmpty: undefined,
		});
	});

	test('computes percentages and per-second rates from two readings', () => {
		const first = { at: 0, cpu: { busy: 100, total: 1000 }, memUsed: 4, memTotal: 16, diskReadBytes: 1000, diskWriteBytes: 0, netRxBytes: 0, netTxBytes: 500, diskUsed: 50, diskTotal: 200, swapUsed: 7 };
		const second = { at: 5_000, cpu: { busy: 600, total: 2000 }, memUsed: 8, memTotal: 16, diskReadBytes: 6000, diskWriteBytes: 10_000, netRxBytes: 50_000, netTxBytes: 400, diskUsed: 50, diskTotal: 200, swapUsed: 9 };
		assert.deepStrictEqual({
			firstReading: paradisComputeSystemUsageSample(undefined, first),
			second: paradisComputeSystemUsageSample(first, second),
			// スリープ明けで 10 分空いた: 速度と CPU は出さない（平均にすると実態と違う）
			afterSleep: paradisComputeSystemUsageSample(first, { ...second, at: 600_000 }),
		}, {
			firstReading: { t: 0, mem: 25, disk: 25, swapUsed: 7 },
			// 送信は累計が減った（カウンタの巻き戻り）ので出さない
			second: { t: 5_000, mem: 50, disk: 25, swapUsed: 9, cpu: 50, diskRead: 1000, diskWrite: 2000, netRx: 10_000 },
			afterSleep: { t: 600_000, mem: 50, disk: 25, swapUsed: 9 },
		});
	});
});
