import Foundation
import UIKit
import AVFoundation
import CallKit
import PushKit
import Capacitor

/// iOS incoming-call integration for Jorcord (CallKit + PushKit VoIP).
///
/// !! UNVERIFIED SKETCH: written without a Mac, Xcode or an Apple Developer account, so it has never been compiled or run. !!
/// Build and test it on a real device (CallKit and PushKit do not work in the simulator for VoIP pushes) before shipping. See docs/PLATFORMS.md.
///
/// JS: Capacitor.Plugins.JorcordCallKit  (bridge: apps/web/src/lib/callkit.ts)
///   isSupported()                                  -> { supported }
///   reportIncomingCall({ callId, caller, video })  -> {}      shows the native incoming-call screen (also used when a VoIP push arrives)
///   reportOutgoingCall({ callId, callee, video })  -> {}      registers an outgoing call so the system treats the app as in a call
///   reportConnected({ callId })                    -> {}
///   endCall({ callId, reason? })                   -> {}      reason: "remoteEnded" | "failed" | "unanswered" | "answeredElsewhere" | "declinedElsewhere"
///   setMuted({ callId, muted })                    -> {}
///   events: "voipToken" { token } · "answer" { callId } · "end" { callId } · "muted" { callId, muted } · "audioSessionActivated" {}
///
/// PushKit rule: every VoIP push MUST result in reportNewIncomingCall before the push handler returns, otherwise iOS terminates the app and
/// eventually stops delivering VoIP pushes. The handler below therefore always reports a call, using the payload's `callId` / `caller`.
@objc(JorcordCallKitPlugin)
public class JorcordCallKitPlugin: CAPPlugin, CAPBridgedPlugin, CXProviderDelegate, PKPushRegistryDelegate {
    public let identifier = "JorcordCallKitPlugin"
    public let jsName = "JorcordCallKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportIncomingCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportOutgoingCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "endCall", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMuted", returnType: CAPPluginReturnPromise)
    ]

    private var provider: CXProvider!
    private let controller = CXCallController()
    private var registry: PKPushRegistry!
    /// Our call id (a Jorcord channel/call id string) -> CallKit's UUID.
    private var uuids: [String: UUID] = [:]

    public override func load() {
        let cfg = CXProviderConfiguration()
        cfg.supportsVideo = true
        cfg.maximumCallsPerCallGroup = 1
        cfg.supportedHandleTypes = [.generic]
        cfg.includesCallsInRecents = false
        provider = CXProvider(configuration: cfg)
        provider.setDelegate(self, queue: nil)
        registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    // MARK: JS API
    @objc func isSupported(_ call: CAPPluginCall) { call.resolve(["supported": true]) }

    @objc func reportIncomingCall(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else { return call.reject("callId required") }
        report(callId: callId, caller: call.getString("caller") ?? "Jorcord", video: call.getBool("video") ?? false) { err in
            if let err = err { call.reject(err.localizedDescription) } else { call.resolve() }
        }
    }

    @objc func reportOutgoingCall(_ call: CAPPluginCall) {
        guard let callId = call.getString("callId") else { return call.reject("callId required") }
        let uuid = uuids[callId] ?? UUID(); uuids[callId] = uuid
        let handle = CXHandle(type: .generic, value: call.getString("callee") ?? "Jorcord")
        let start = CXStartCallAction(call: uuid, handle: handle)
        start.isVideo = call.getBool("video") ?? false
        controller.request(CXTransaction(action: start)) { err in
            if let err = err { call.reject(err.localizedDescription) } else { call.resolve() }
        }
    }

    @objc func reportConnected(_ call: CAPPluginCall) {
        if let id = call.getString("callId"), let uuid = uuids[id] { provider.reportOutgoingCall(with: uuid, connectedAt: Date()) }
        call.resolve()
    }

    @objc func endCall(_ call: CAPPluginCall) {
        guard let id = call.getString("callId"), let uuid = uuids[id] else { return call.resolve() }
        uuids[id] = nil
        let reasons: [String: CXCallEndedReason] = ["failed": .failed, "unanswered": .unanswered, "answeredElsewhere": .answeredElsewhere, "declinedElsewhere": .declinedElsewhere, "remoteEnded": .remoteEnded]
        if let r = call.getString("reason"), let reason = reasons[r] { provider.reportCall(with: uuid, endedAt: Date(), reason: reason); return call.resolve() }
        controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { _ in call.resolve() }
    }

    @objc func setMuted(_ call: CAPPluginCall) {
        if let id = call.getString("callId"), let uuid = uuids[id] { controller.request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: call.getBool("muted") ?? false))) { _ in } }
        call.resolve()
    }

    // MARK: helpers
    private func report(callId: String, caller: String, video: Bool, completion: @escaping (Error?) -> Void) {
        let uuid = uuids[callId] ?? UUID(); uuids[callId] = uuid
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: caller)
        update.localizedCallerName = caller
        update.hasVideo = video
        provider.reportNewIncomingCall(with: uuid, update: update, completion: completion)
    }
    private func callId(for uuid: UUID) -> String? { uuids.first(where: { $0.value == uuid })?.key }

    // MARK: PKPushRegistryDelegate
    public func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        notifyListeners("voipToken", data: ["token": token]) // the web layer registers it with POST /users/@me/push-devices (follow-up: platform "ios-voip", see docs/PLATFORMS.md)
    }
    public func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let d = payload.dictionaryPayload
        // Never skip reporting: iOS kills apps that receive a VoIP push and do not show a call.
        report(callId: (d["callId"] as? String) ?? UUID().uuidString, caller: (d["caller"] as? String) ?? "Jorcord", video: (d["video"] as? Bool) ?? false) { _ in completion() }
    }

    // MARK: CXProviderDelegate
    public func providerDidReset(_ provider: CXProvider) { uuids.removeAll() }
    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        if let id = callId(for: action.callUUID) { notifyListeners("answer", data: ["callId": id]) }
        action.fulfill()
    }
    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        if let id = callId(for: action.callUUID) { notifyListeners("end", data: ["callId": id]); uuids[id] = nil }
        action.fulfill()
    }
    public func provider(_ provider: CXProvider, perform action: CXStartCallAction) { action.fulfill(); provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date()) }
    public func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        if let id = callId(for: action.callUUID) { notifyListeners("muted", data: ["callId": id, "muted": action.isMuted]) }
        action.fulfill()
    }
    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) { notifyListeners("audioSessionActivated", data: [:]) }
}
