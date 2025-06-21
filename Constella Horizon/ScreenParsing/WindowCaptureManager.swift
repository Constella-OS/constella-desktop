import SwiftUI
import CoreGraphics
import CoreImage
import Vision
import Dispatch
import ScreenCaptureKit
import Combine
import CoreMedia
private let kAXWindowNumberAttribute: CFString = "AXWindowNumber" as CFString


extension CGFloat {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let doubleValue = try container.decode(Double.self)
        self.init(doubleValue)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(Double(self))
    }
}

struct TextBoundingBox: Codable {
    var top: CGFloat
    var left: CGFloat
    var width: CGFloat
    var height: CGFloat
}

struct OCRResult: Codable {
    var text: String
    var confidence: Float
    var boundingBoxRaw: CGRect
    var id: Int?
    var boundingBox: TextBoundingBox?

    private enum CodingKeys: String, CodingKey {
        case id
        case text
        case confidence
        case boundingBox = "bbox"
        case boundingBoxRaw
    }
}

//// Managing capture
class WindowCaptureManager {
    static let shared = WindowCaptureManager()
    private var stream: SCStream?
    private var streamOutput: StreamOutput?
    private var contentFilter: SCContentFilter?
    private var lastCaptureImage: CGImage?
    private init() {}

    // MARK: - Public Async APIs

    /// Capture a specific window by its ID.
    public func captureWindow(_ windowID: CGWindowID) async -> CGImage? {
        do {
            let availableContent = try await SCShareableContent
                .excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let window = availableContent.windows.first(
                where: { $0.windowID == windowID }
            ) else {
                print("Window with ID \(windowID) not found")
                return nil
            }
            return await captureWithFilter(
                SCContentFilter(desktopIndependentWindow: window)
            )
        } catch {
            print("Error getting shareable content: \(error)")
            return nil
        }
    }

    /// Capture the main display if no window is found.
    public func captureMainDisplay() async -> CGImage? {
        do {
            let availableContent = try await SCShareableContent
                .excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = availableContent.displays.first else {
                print("No displays available")
                return nil
            }
            let filter = SCContentFilter(
                display: display,
                excludingApplications: [],
                exceptingWindows: []
            )
            return await captureWithFilter(filter)
        } catch {
            print("Error getting shareable content: \(error)")
            return nil
        }
    }

    /// Perform OCR on a captured image.
    public func performOCR(on image: CGImage) async -> [OCRResult] {
        await withCheckedContinuation { continuation in
            let imageSize = CGSize(width: image.width, height: image.height)
            let handler = VNImageRequestHandler(cgImage: image)
            let request = VNRecognizeTextRequest { request, error in
                let results: [OCRResult]
                if let observations = request.results as? [VNRecognizedTextObservation] {
                    var counter = 0
                    results = observations.compactMap { obs in
                        guard let candidate = obs.topCandidates(1).first else { return nil }
                        let rect = VNImageRectForNormalizedRect(
                            obs.boundingBox,
                            Int(imageSize.width),
                            Int(imageSize.height)
                        )
                        let bbox = TextBoundingBox(
                            top: rect.origin.y,
                            left: rect.origin.x,
                            width: rect.size.width,
                            height: rect.size.height
                        )
                        defer { counter += 1 }
                        return OCRResult(
                            text: candidate.string,
                            confidence: candidate.confidence,
                            boundingBoxRaw: rect,
                            id: counter,
                            boundingBox: bbox
                        )
                    }
                } else {
                    results = []
                }
                continuation.resume(returning: results)
            }
            request.recognitionLanguages = ["en-US"]
            request.recognitionLevel = .accurate
            request.revision = VNRecognizeTextRequestRevision3
            do {
                try handler.perform([request])
            } catch {
                print("Unable to perform OCR: \(error)")
                continuation.resume(returning: [])
            }
        }
    }

    /// Capture and OCR the foreground window or main display.
    public func captureAndProcessText() async -> [OCRResult] {
        /* Used to use the captureForegroundWindow, but that's limited / if there is overlays */
        if let image = await captureMainDisplay() {
            let image2 = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
            return await performOCR(on: image)
        }
        return []
    }

    // MARK: - Private Async Capture Helper

    /// Internal filter-based capture returning a single frame.
    private func captureWithFilter(_ filter: SCContentFilter) async -> CGImage? {
        // Stop any existing capture stream
        do{
            try await stopCapture()
            
            // Stream configuration
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = false
            configuration.showsCursor = false
            
            // Derive width/height from the filter's content rectangle
            let contentRect = filter.contentRect
            let scale = filter.pointPixelScale
            if contentRect.width > 0 && contentRect.height > 0 {
                configuration.width  = Int(contentRect.width  * CGFloat(scale))
                configuration.height = Int(contentRect.height * CGFloat(scale))
            } else {
                configuration.width  = 1920
                configuration.height = 1080
            }
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
            configuration.queueDepth = 3
            
            // Prepare stream output
            let streamOutput = StreamOutput()
            self.streamOutput = streamOutput
            
            // Ensure stream is stopped if this Task is cancelled
            let image = await withCheckedContinuation { (continuation: CheckedContinuation<CGImage?, Never>) in
                var didResume = false
                var capturedImage: CGImage? = nil
                
                // Timeout after 3 seconds
                let timeoutWorkItem = DispatchWorkItem {
                    guard !didResume else { return }
                    didResume = true
                    continuation.resume(returning: capturedImage)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: timeoutWorkItem)
                
                // Frame capture handler
                streamOutput.captureHandler = { image in
                    guard !didResume else { return }
                    didResume = true
                    capturedImage = image
                    timeoutWorkItem.cancel()
                    continuation.resume(returning: image)
                }
                
                // Start the stream asynchronously
                
                do {
                    let stream = SCStream(filter: filter,
                                          configuration: configuration,
                                          delegate: nil)
                    try stream.addStreamOutput(streamOutput,
                                               type: .screen,
                                               sampleHandlerQueue: .main)
                    stream.startCapture { error in
                        if let error = error {
                            if !didResume {
                                didResume = true
                                timeoutWorkItem.cancel()
                                continuation.resume(returning: nil)
                            }
                            print("Failed to start capture: \(error)")
                        } else {
                            self.stream = stream
                        }
                    }
                } catch {
                    if !didResume {
                        didResume = true
                        timeoutWorkItem.cancel()
                        continuation.resume(returning: nil)
                    }
                }
            }

            try await Task.sleep(for: .milliseconds(100))
            try await stopCapture()
            return image
        }
        catch{
            return nil
        }
    }

    /// Stop and clean up any ongoing capture stream.
    private func stopCapture() async throws{
        try await stream?.stopCapture()
        stream = nil
        streamOutput = nil
        contentFilter = nil
    }
}

// Private SCStreamOutput implementation
private class StreamOutput: NSObject, SCStreamOutput {
    var captureHandler: ((CGImage?) -> Void)?
    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen,
              let handler = captureHandler,
              sampleBuffer.isValid,
              let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
              ) as? [[SCStreamFrameInfo: Any]],
              let attachments = attachmentsArray.first,
              let statusRaw = attachments[SCStreamFrameInfo.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw),
              status == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer)
        else { return }
        let ciImage = CIImage(cvPixelBuffer: buffer)
        let context = CIContext()
        if let cgImage = context.createCGImage(ciImage, from: ciImage.extent) {
            handler(cgImage)
        }
    }
}
