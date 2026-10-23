import ReplayKit
import CoreImage
import CoreMedia
import UIKit
import ImageIO
import QuartzCore

/// ReplayKit Broadcast Upload Extension. Runs in its own process under a ~50 MB memory cap, so it does the bare minimum:
/// downscale each (throttled) video frame, JPEG-encode it into the shared app-group container and ping the app with a
/// Darwin notification. The app (JorcordScreenSharePlugin) forwards the frames to the web layer.
class SampleHandler: RPBroadcastSampleHandler {
    // Keep in sync with App/ScreenSharePlugin.swift.
    private let groupKey = "JorcordAppGroup"
    private let nFrame = "app.jorcord.mobile.screenshare.frame"
    private let nStarted = "app.jorcord.mobile.screenshare.started"
    private let nStopped = "app.jorcord.mobile.screenshare.stopped"
    private let nStop = "app.jorcord.mobile.screenshare.stop"

    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let maxDimension: CGFloat = 1280
    private let minInterval: CFTimeInterval = 0.125 // 8 fps
    private let jpegQuality: CGFloat = 0.6
    private var lastSent: CFTimeInterval = 0
    private var frameURL: URL?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        if let group = Bundle.main.object(forInfoDictionaryKey: groupKey) as? String,
           let base = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) {
            frameURL = base.appendingPathComponent("screenshare-frame.jpg")
        }
        guard frameURL != nil else {
            finishBroadcastWithError(NSError(domain: "app.jorcord.mobile.screenshare", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Screen sharing is not set up in this build (app group missing)."]))
            return
        }
        // The app asks us to stop through the same Darwin channel.
        CFNotificationCenterAddObserver(CFNotificationCenterGetDarwinNotifyCenter(),
            Unmanaged.passUnretained(self).toOpaque(), { _, observer, _, _, _ in
                guard let observer = observer else { return }
                let me = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
                me.finishBroadcastWithError(NSError(domain: "app.jorcord.mobile.screenshare", code: 0,
                    userInfo: [NSLocalizedDescriptionKey: "Screen sharing stopped."]))
            }, nStop as CFString, nil, .deliverImmediately)
        post(nStarted)
    }

    override func broadcastFinished() {
        CFNotificationCenterRemoveEveryObserver(CFNotificationCenterGetDarwinNotifyCenter(), Unmanaged.passUnretained(self).toOpaque())
        post(nStopped)
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video, let url = frameURL else { return }
        let now = CACurrentMediaTime()
        guard now - lastSent >= minInterval else { return }
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastSent = now

        autoreleasepool {
            var image = CIImage(cvPixelBuffer: pixels)
            if let raw = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber,
               let orientation = CGImagePropertyOrientation(rawValue: raw.uint32Value) {
                image = image.oriented(orientation)
            }
            let longest = max(image.extent.width, image.extent.height)
            if longest > maxDimension {
                let s = maxDimension / longest
                image = image.transformed(by: CGAffineTransform(scaleX: s, y: s))
            }
            let options: [CIImageRepresentationOption: Any] = [
                CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): jpegQuality
            ]
            guard let data = try? ciContext.jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB(), options: options) else { return }
            do {
                try data.write(to: url, options: .atomic)
                post(nFrame)
            } catch {
                // Dropping a frame is fine; the next one overwrites it.
            }
        }
    }

    private func post(_ name: String) {
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(name as CFString), nil, nil, true)
    }
}
