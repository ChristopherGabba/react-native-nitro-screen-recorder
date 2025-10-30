// MARK: Broadcast Writer

// Copied from the repo: 
// https://github.com/romiroma/BroadcastWriter

import AVFoundation
import CoreGraphics
import Foundation
import ReplayKit

extension AVAssetWriter.Status {
  var description: String {
    switch self {
    case .cancelled: return "cancelled"
    case .completed: return "completed"
    case .failed: return "failed"
    case .unknown: return "unknown"
    case .writing: return "writing"
    @unknown default: return "@unknown default"
    }
  }
}

extension CGFloat {
  var nsNumber: NSNumber {
    return .init(value: native)
  }
}

extension Int {
  var nsNumber: NSNumber {
    return .init(value: self)
  }
}

enum Error: Swift.Error {
  case wrongAssetWriterStatus(AVAssetWriter.Status)
  case selfDeallocated
}

public final class BroadcastWriter {

  private var assetWriterSessionStarted: Bool = false
  private let assetWriterQueue: DispatchQueue
  private let assetWriter: AVAssetWriter

  private lazy var videoInput: AVAssetWriterInput = { [unowned self] in
    let videoWidth = screenSize.width * screenScale
    let videoHeight = screenSize.height * screenScale

    // Ensure encoder-friendly even dimensions
    let w = (Int(videoWidth) / 2) * 2
    let h = (Int(videoHeight) / 2) * 2

    // Decide codec: prefer HEVC when available
    let hevcSupported: Bool = {
      if #available(iOS 11.0, *) {
        return self.assetWriter.canApply(
          outputSettings: [AVVideoCodecKey: AVVideoCodecType.hevc],
          forMediaType: .video
        )
      }
      return false
    }()

    let codec: AVVideoCodecType = hevcSupported ? .hevc : .h264

    var compressionProperties: [String: Any] = [
      AVVideoExpectedSourceFrameRateKey: 60.nsNumber
    ]
    if hevcSupported {
      // Works broadly; adjust if you need different profiles
      compressionProperties[AVVideoProfileLevelKey] = "HEVC_Main_AutoLevel"
    } else {
      compressionProperties[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel
    }

    let videoSettings: [String: Any] = [
      AVVideoCodecKey: codec,
      AVVideoWidthKey: w.nsNumber,
      AVVideoHeightKey: h.nsNumber,
      AVVideoCompressionPropertiesKey: compressionProperties,
    ]

    let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    input.expectsMediaDataInRealTime = true
    return input
  }()

  private var audioSampleRate: Double {
    AVAudioSession.sharedInstance().sampleRate
  }
  private lazy var audioInput: AVAssetWriterInput = {

    var audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: audioSampleRate,
    ]
    let input: AVAssetWriterInput = .init(
      mediaType: .audio,
      outputSettings: audioSettings
    )
    input.expectsMediaDataInRealTime = true
    return input
  }()

  private lazy var microphoneInput: AVAssetWriterInput = {
    var audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: audioSampleRate,
    ]
    let input: AVAssetWriterInput = .init(
      mediaType: .audio,
      outputSettings: audioSettings
    )
    input.expectsMediaDataInRealTime = true
    return input
  }()

  private lazy var inputs: [AVAssetWriterInput] = [
    videoInput,
    audioInput,
    microphoneInput,
  ]

  private let screenSize: CGSize
  private let screenScale: CGFloat

  public init(
    outputURL url: URL,
    assetWriterQueue queue: DispatchQueue = .init(label: "BroadcastSampleHandler.assetWriterQueue"),
    screenSize: CGSize,
    screenScale: CGFloat
  ) throws {
    assetWriterQueue = queue
    assetWriter = try .init(url: url, fileType: .mp4)

    self.screenSize = screenSize
    self.screenScale = screenScale
  }

  public func start() throws {
    try assetWriterQueue.sync {
      let status = assetWriter.status
      guard status == .unknown else {
        throw Error.wrongAssetWriterStatus(status)
      }
      try assetWriter.error.map {
        throw $0
      }
      inputs
        .lazy
        .filter(assetWriter.canAdd(_:))
        .forEach(assetWriter.add(_:))
      try assetWriter.error.map {
        throw $0
      }
      assetWriter.startWriting()
      try assetWriter.error.map {
        throw $0
      }
    }
  }

  public func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) throws -> Bool {

    guard sampleBuffer.isValid,
      CMSampleBufferDataIsReady(sampleBuffer)
    else {
      debugPrint(
        "sampleBuffer.isValid", sampleBuffer.isValid,
        "CMSampleBufferDataIsReady(sampleBuffer)", CMSampleBufferDataIsReady(sampleBuffer)
      )
      return false
    }

    let isWriting = assetWriterQueue.sync {
      assetWriter.status == .writing
    }

    guard isWriting else {
      debugPrint(
        "assetWriter.status",
        assetWriter.status.description,
        "assetWriter.error:",
        assetWriter.error ?? "no error"
      )
      return false
    }

    assetWriterQueue.sync {
      startSessionIfNeeded(sampleBuffer: sampleBuffer)
    }

    let capture: (CMSampleBuffer) -> Bool
    switch sampleBufferType {
    case .video:
      capture = captureVideoOutput
    case .audioApp:
      capture = captureAudioOutput
    case .audioMic:
      capture = captureMicrophoneOutput
    @unknown default:
      debugPrint(#file, "Unknown type of sample buffer, \(sampleBufferType)")
      capture = { _ in false }
    }

    return assetWriterQueue.sync {
      capture(sampleBuffer)
    }
  }

  public func pause() {
    // TODO: Pause
  }

  public func resume() {
    // TODO: Resume
  }

  public func finish() throws -> URL {
    return try assetWriterQueue.sync {
      let group: DispatchGroup = .init()

      inputs
        .lazy
        .filter { $0.isReadyForMoreMediaData }
        .forEach { $0.markAsFinished() }

      let status = assetWriter.status
      guard status == .writing else {
        throw Error.wrongAssetWriterStatus(status)
      }
      group.enter()

      var error: Swift.Error?
      assetWriter.finishWriting { [weak self] in

        defer {
          group.leave()
        }

        guard let self = self else {
          error = Error.selfDeallocated
          return
        }

        if let e = self.assetWriter.error {
          error = e
          return
        }

        let status = self.assetWriter.status
        guard status == .completed else {
          error = Error.wrongAssetWriterStatus(status)
          return
        }
      }
      group.wait()
      try error.map { throw $0 }
      return assetWriter.outputURL
    }
  }
}

extension BroadcastWriter {

  fileprivate func startSessionIfNeeded(sampleBuffer: CMSampleBuffer) {
    guard !assetWriterSessionStarted else {
      return
    }

    let sourceTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    assetWriter.startSession(atSourceTime: sourceTime)
    assetWriterSessionStarted = true
  }

  fileprivate func captureVideoOutput(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard videoInput.isReadyForMoreMediaData else {
      debugPrint("videoInput is not ready")
      return false
    }
    return videoInput.append(sampleBuffer)
  }

  fileprivate func captureAudioOutput(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard audioInput.isReadyForMoreMediaData else {
      debugPrint("audioInput is not ready")
      return false
    }
    return audioInput.append(sampleBuffer)
  }

  fileprivate func captureMicrophoneOutput(_ sampleBuffer: CMSampleBuffer) -> Bool {

    guard microphoneInput.isReadyForMoreMediaData else {
      debugPrint("microphoneInput is not ready")
      return false
    }
    return microphoneInput.append(sampleBuffer)
  }
}
