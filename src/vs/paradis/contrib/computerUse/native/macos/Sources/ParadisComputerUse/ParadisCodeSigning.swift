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

/** 相手の事実を集める。 */
func paradisCollectPeerFacts(socket fd: Int32, helper: ParadisSigningIdentity) -> ParadisPeerFacts? {
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
	let parentBundleIdentifier = parentPid.flatMap { parentPid in
		paradisOnMain { NSRunningApplication(processIdentifier: parentPid)?.bundleIdentifier }
	}
	let parentParentPid = parentPid.flatMap { paradisParentPid(of: $0) }
	return ParadisPeerFacts(
		helper: helper,
		peer: peer,
		parent: parent,
		parentBundleIdentifier: parentBundleIdentifier,
		parentParentPid: parentParentPid,
		sameUser: peerUid == getuid()
	)
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
