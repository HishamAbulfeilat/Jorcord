import Foundation
import UIKit
import ReplayKit
import Capacitor

/// JS: Capacitor.Plugins.JorcordScreenShare
///   isSupported() -> { supported }          false when the broadcast extension / app group are not available (e.g. unsigned build)
///   start()       -> {}                     shows the system broadcast picker; resolves once the user has started the broadcast
///   stop()        -> {}                     asks the extension to finish the broadcast
///   events: "frame" { data: base64 jpeg }, "stopped" { reason }
///
/// The screen is captured by the BroadcastExtension target (ReplayKit Broadcast Upload Extension), which runs in its own
/// process with a ~50 MB memory cap. It scales + JPEG-encodes frames into the shared app-group container and posts a
/// Darwin notification; this plugin (the app stays alive in the background through the call's audio session) reads the file
/// and forwards it to the web layer, which publishes it as a LiveKit track.
@objc(JorcordScreenSharePlugin)
public class JorcordScreenSharePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "JorcordScreenSharePlugin"
    public let jsName = "JorcordScreenShare"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise)
    ]

    // Keep in sync with BroadcastExtension/SampleHandler.swift.
    private static let groupKey = "JorcordAppGroup"
    private static let nFrame = "app.jorcord.mobile.screenshare.frame"
    private static let nStarted = "app.jorcord.mobile.screenshare.started"
    private static let nStopped = "app.jorcord.mobile.screenshare.stopped"
    private static let nStop = "app.jorcord.mobile.screenshare.stop"

    private var pendingStart: CAPPluginCall?
    private var startTimeout: DispatchWorkItem?
    private var broadcasting = false
    private var reading = false
    private let ioQueue = DispatchQueue(label: "app.jorcord.screenshare.io")

    private var groupId: String? { Bundle.main.object(forInfoDictionaryKey: Self.groupKey) as? String }
    private var frameURL: URL? {
        guard let g = groupId,
              let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: g) else { return nil }
        return base.appendingPathComponent("screenshare-frame.jpg")
    }
    private var extensionBundleId: String { (Bundle.main.bundleIdentifier ?? "app.jorcord.mobile") + ".broadcast" }
    private var extensionPresent: Bool {
        guard let plugIns = Bundle.main.builtInPlugInsURL else { return false }
        return FileManager.default.fileExists(atPath: plugIns.appendingPathComponent("BroadcastExtension.appex").path)
    }

    override public func load() {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let me = Unmanaged.passUnretained(self).toOpaque()
        for name in [Self.nFrame, Self.nStarted, Self.nStopped] {
            CFNotificationCenterAddObserver(center, me, { _, observer, name, _, _ in
                guard let observer = observer, let name = name else { return }
                let plugin = Unmanaged<JorcordScreenSharePlugin>.fromOpaque(observer).takeUnretainedValue()
                plugin.handleDarwin(name.rawValue as String)
            }, name as CFString, nil, .deliverImmediately)
        }
    }

    deinit {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        // containerURL is nil when the app-group entitlement is missing (unsigned / re-signed without the group).
        call.resolve(["supported": extensionPresent && frameURL != nil])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard extensionPresent, frameURL != nil else {
            call.reject("Screen sharing is not available in this build", "UNSUPPORTED"); return
        }
        if pendingStart != nil || broadcasting { call.reject("Already sharing", "BUSY"); return }
        pendingStart = call
        // Stale frame from an earlier broadcast must not be shown as the first frame.
        if let url = frameURL { try? FileManager.default.removeItem(at: url) }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController?.view else { return }
            let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
            picker.preferredExtension = self.extensionBundleId
            picker.showsMicrophoneButton = false
            picker.alpha = 0.01
            host.addSubview(picker)
            // The picker has no public "present" API; activating its inner button is the documented-by-practice way.
            (picker.subviews.compactMap { $0 as? UIButton }.first)?.sendActions(for: .touchUpInside)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { picker.removeFromSuperview() }
        }
        // iOS reports no event when the user dismisses the picker, so give up after a while.
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, let c = self.pendingStart else { return }
            self.pendingStart = nil
            c.reject("Screen share was cancelled", "CANCELLED")
        }
        startTimeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: work)
    }

    /// Opens this app's page in the Settings app (mic / camera / notifications toggles) for the "blocked" state.
    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { call.reject("unavailable"); return }
            UIApplication.shared.open(url, options: [:]) { ok in ok ? call.resolve() : call.reject("could not open settings") }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        post(Self.nStop)
        call.resolve()
    }

    private func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }

    fileprivate func handleDarwin(_ name: String) {
        switch name {
        case Self.nStarted:
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.broadcasting = true
                self.startTimeout?.cancel()
                if let c = self.pendingStart { self.pendingStart = nil; c.resolve() }
            }
        case Self.nStopped:
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                let was = self.broadcasting
                self.broadcasting = false
                if let c = self.pendingStart { self.pendingStart = nil; c.reject("Screen share failed to start", "FAILED") }
                else if was { self.notifyListeners("stopped", data: ["reason": "stopped"]) }
            }
        case Self.nFrame:
            forwardFrame()
        default:
            break
        }
    }

    /// Reads the newest frame; if one is already being read the notification is skipped (newer frames supersede it).
    private func forwardFrame() {
        ioQueue.async { [weak self] in
            guard let self = self, !self.reading, let url = self.frameURL else { return }
            self.reading = true
            defer { self.reading = false }
            guard let data = try? Data(contentsOf: url), !data.isEmpty else { return }
            self.notifyListeners("frame", data: ["data": data.base64EncodedString()])
        }
    }
}
