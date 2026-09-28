/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// つないできた相手の事実（署名・親・ユーザー）を集める。判断は ParadisPeerPolicy.swift。

import AppKit
import Darwin
import Foundation
import Security

/** `SOL_LOCAL` の `LOCAL_PEERPID` / `LOCAL_PEERTOKEN`（sys/un.h）。Swift から名前で引けない SDK があるので数で持つ。 */
private let paradisSolLocal: Int32 = 0
private let paradisLocalPeerPid: Int32 = 2
private let paradisLocalPeerToken: Int32 = 6

/** 補助アプリ自身の署名。読めなければ識別子もチームも無いもの（= 開発用として扱う）。 */
func paradisSelfSigningIdentity() -> ParadisSigningIdentity {
	var code: SecCode?
	guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else {
		return ParadisSigningIdentity(identifier: nil, teamIdentifier: nil)
	}
	return paradisSigningInformation(of: code) ?? ParadisSigningIdentity(identifier: nil, teamIdentifier: nil)
}

/** 受け入れた相手の pid と、その親（Para Code の main）の pid。 */
struct ParadisPeerProcesses {
	let peerPid: pid_t
	let parentPid: pid_t?
}

/** 相手の事実を集める。 */
func paradisCollectPeerFacts(socket fd: Int32, helper: ParadisSigningIdentity) -> (ParadisPeerFacts, ParadisPeerProcesses)? {
	var peerUid = uid_t(0)
	var peerGid = gid_t(0)
	guard getpeereid(fd, &peerUid, &peerGid) == 0 else {
		return nil
	}
	var pid = pid_t(0)
	var pidLength = socklen_t(MemoryLayout<pid_t>.size)
	guard getsockopt(fd, paradisSolLocal, paradisLocalPeerPid, &pid, &pidLength) == 0, pid > 0 else {
		return nil
	}
	var token = audit_token_t()
	var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
	guard getsockopt(fd, paradisSolLocal, paradisLocalPeerToken, &token, &tokenLength) == 0 else {
		return nil
	}
	let requirement = paradisTeamRequirement(helper.teamIdentifier)
	// 相手は audit token で引く（pid の使い回しで別のプロセスを見ないように）
	let tokenData = withUnsafeBytes(of: &token) { Data($0) }
	let peer = paradisValidatedIdentity(attributes: [kSecGuestAttributeAudit: tokenData], requirement: requirement)
	let parentPid = paradisParentPid(of: pid)
	let parent = parentPid.flatMap { paradisValidatedIdentity(attributes: [kSecGuestAttributePid: NSNumber(value: $0)], requirement: requirement) }
	let peerArguments = paradisProcessArguments(pid: pid)
	let parentArguments = parentPid.flatMap { paradisProcessArguments(pid: $0) }
	let facts = ParadisPeerFacts(
		helper: helper,
		peer: peer,
		parent: parent,
		peerBundleIdentifier: peerArguments.flatMap { paradisBundleIdentifier(containing: $0.executablePath) },
		parentBundleIdentifier: parentArguments.flatMap { paradisBundleIdentifier(containing: $0.executablePath) },
		peerArguments: peerArguments,
		parentArguments: parentArguments,
		parentParentPid: parentPid.flatMap { paradisParentPid(of: $0) },
		sameUser: peerUid == getuid()
	)
	return (facts, ParadisPeerProcesses(peerPid: pid, parentPid: parentPid))
}

/** 起動時の引数と環境変数（同じユーザーのプロセスなら読める）。 */
func paradisProcessArguments(pid: pid_t) -> ParadisProcessArguments? {
	var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
	var size = 0
	guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0, size < 4 * 1024 * 1024 else {
		return nil
	}
	var buffer = [UInt8](repeating: 0, count: size)
	guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0 else {
		return nil
	}
	return paradisParseProcessArguments(Array(buffer.prefix(size)))
}

/** 実行ファイルを含む一番内側の .app の bundle id。 */
func paradisBundleIdentifier(containing executablePath: String) -> String? {
	var url = URL(fileURLWithPath: executablePath)
	while url.path != "/" {
		if url.pathExtension == "app" {
			return Bundle(url: url)?.bundleIdentifier
		}
		url.deleteLastPathComponent()
	}
	return nil
}

/** 親の pid。取れなければ nil。 */
func paradisParentPid(of pid: pid_t) -> pid_t? {
	var info = proc_bsdinfo()
	let size = Int32(MemoryLayout<proc_bsdinfo>.size)
	guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else {
		return nil
	}
	return pid_t(info.pbi_ppid)
}

/** 補助アプリにチーム ID があれば、そのチームの Developer ID で署名されていることを求める要件。 */
private func paradisTeamRequirement(_ team: String?) -> SecRequirement? {
	guard let team, !team.isEmpty, team.allSatisfy({ $0.isLetter || $0.isNumber }) else {
		return nil
	}
	var requirement: SecRequirement?
	let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(team)\"" as CFString
	guard SecRequirementCreateWithString(text, SecCSFlags(), &requirement) == errSecSuccess else {
		return nil
	}
	return requirement
}

/**
 * 相手の署名を検証して読む。チームの要件があればそれも満たすこと。
 * リリースでチームの要件を作れなかったときは、何も通さない（nil を返す）。
 */
private func paradisValidatedIdentity(attributes: [CFString: Any], requirement: SecRequirement?) -> ParadisSigningIdentity? {
	var code: SecCode?
	guard SecCodeCopyGuestWithAttributes(nil, attributes as CFDictionary, SecCSFlags(), &code) == errSecSuccess, let code else {
		return nil
	}
	guard SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess else {
		return nil
	}
	return paradisSigningInformation(of: code)
}

private func paradisSigningInformation(of code: SecCode) -> ParadisSigningIdentity? {
	var staticCode: SecStaticCode?
	guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else {
		return nil
	}
	var information: CFDictionary?
	guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
		let dictionary = information as? [String: Any]
	else {
		return nil
	}
	return ParadisSigningIdentity(
		identifier: dictionary[kSecCodeInfoIdentifier as String] as? String,
		teamIdentifier: dictionary[kSecCodeInfoTeamIdentifier as String] as? String
	)
}

/** 自分がどのプロセスの責任で動いているか（非公開 API。無ければ unknown）。 */
func paradisResponsiblePid() -> pid_t? {
	typealias ResponsibleFunction = @convention(c) (pid_t) -> pid_t
	guard let handle = dlopen(nil, RTLD_NOW), let symbol = dlsym(handle, "responsibility_get_pid_responsible_for_pid") else {
		return nil
	}
	let function = unsafeBitCast(symbol, to: ResponsibleFunction.self)
	let pid = function(getpid())
	return pid > 0 ? pid : nil
}

/** AppKit の問い合わせは main スレッドで行う。 */
func paradisOnMain<T>(_ work: () -> T) -> T {
	if Thread.isMainThread {
		return work()
	}
	return DispatchQueue.main.sync(execute: work)
}

// MARK: - 待ち受けのポート（レビュー N2）

/** そのプロセスが TCP で待ち受けているポート。読めなければ nil。 */
func paradisListeningTcpPorts(pid: pid_t) -> Set<Int>? {
	let bufferSize = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0)
	guard bufferSize > 0 else {
		return nil
	}
	let stride = MemoryLayout<proc_fdinfo>.stride
	var descriptors = [proc_fdinfo](repeating: proc_fdinfo(), count: Int(bufferSize) / stride + 16)
	let used = descriptors.withUnsafeMutableBytes { raw in
		proc_pidinfo(pid, PROC_PIDLISTFDS, 0, raw.baseAddress, Int32(raw.count))
	}
	guard used > 0 else {
		return nil
	}
	var ports = Set<Int>()
	for descriptor in descriptors.prefix(Int(used) / stride) where descriptor.proc_fdtype == UInt32(PROX_FDTYPE_SOCKET) {
		var info = socket_fdinfo()
		let size = Int32(MemoryLayout<socket_fdinfo>.size)
		guard proc_pidfdinfo(pid, descriptor.proc_fd, PROC_PIDFDSOCKETINFO, &info, size) == size else {
			continue
		}
		guard info.psi.soi_kind == Int32(SOCKINFO_TCP), info.psi.soi_proto.pri_tcp.tcpsi_state == Int32(TSI_S_LISTEN) else {
			continue
		}
		let port = Int(UInt16(bigEndian: UInt16(truncatingIfNeeded: info.psi.soi_proto.pri_tcp.tcpsi_ini.insi_lport)))
		ports.insert(port)
	}
	return ports
}

// MARK: - アプリの封印（レビュー N2）

/**
 * Para Code.app の封印（署名と、封印された resources）を読み直して確かめる。アプリの中の JS を書き換えると、
 * 本物の shared process で他人のコードが動くため。`_metadata/` の下の出入りだけは許す（`paradisSealProblem`）。
 * 問題が無ければ nil。
 */
func paradisVerifyAppSeal(bundlePath: String, requirement teamIdentifier: String) -> String? {
	var staticCode: SecStaticCode?
	guard SecStaticCodeCreateWithPath(URL(fileURLWithPath: bundlePath) as CFURL, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode else {
		return "the Para Code app could not be opened for verification"
	}
	var requirement: SecRequirement?
	let text = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamIdentifier)\"" as CFString
	guard SecRequirementCreateWithString(text, SecCSFlags(), &requirement) == errSecSuccess else {
		return "the signing requirement could not be built"
	}
	var error: Unmanaged<CFError>?
	let flags = SecCSFlags(rawValue: kSecCSCheckNestedCode | kSecCSStrictValidate)
	let status = SecStaticCodeCheckValidityWithErrors(staticCode, flags, requirement, &error)
	if status == errSecSuccess {
		return nil
	}
	let info = (error?.takeRetainedValue()).flatMap { CFErrorCopyUserInfo($0) as? [String: Any] } ?? [:]
	func paths(_ key: CFString) -> [String] {
		return (info[key as String] as? [Any] ?? []).compactMap { ($0 as? URL)?.path ?? ($0 as? String) }
	}
	let added = paths(kSecCFErrorResourceAdded)
	let altered = paths(kSecCFErrorResourceAltered)
	let missing = paths(kSecCFErrorResourceMissing)
	if added.isEmpty && altered.isEmpty && missing.isEmpty {
		return "the Para Code app signature is not valid (\(status))"
	}
	return paradisSealProblem(added: added, altered: altered, missing: missing)
}

/** 実行ファイルを含む一番内側の .app の場所。 */
func paradisBundlePath(containing executablePath: String) -> String? {
	var url = URL(fileURLWithPath: executablePath)
	while url.path != "/" {
		if url.pathExtension == "app" {
			return url.path
		}
		url.deleteLastPathComponent()
	}
	return nil
}
