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
  private var audioAssetWriterSessionStarted: Bool = false
  private let assetWriterQueue: DispatchQueue
  private let assetWriter: AVAssetWriter

  // Separate mic audio writer
  private var separateAudioWriter: AVAssetWriter?
  private let separateAudioFile: Bool
  private let audioOutputURL: URL?

  // Separate app audio writer
  private var appAudioWriter: AVAssetWriter?
  private let appAudioOutputURL: URL?
  private var appAudioAssetWriterSessionStarted: Bool = false

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

  // Separate audio file input (for microphone audio only)
  private lazy var separateAudioInput: AVAssetWriterInput = {
    var audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: audioSampleRate,
      AVEncoderBitRateKey: 128000,
    ]
    let input: AVAssetWriterInput = .init(
      mediaType: .audio,
      outputSettings: audioSettings
    )
    input.expectsMediaDataInRealTime = true
    return input
  }()

  // Separate app audio file input
  private lazy var appAudioInput: AVAssetWriterInput = {
    var audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: audioSampleRate,
      AVEncoderBitRateKey: 128000,
    ]
    let input: AVAssetWriterInput = .init(
      mediaType: .audio,
      outputSettings: audioSettings
    )
    input.expectsMediaDataInRealTime = true
    return input
  }()

  // Main video file inputs: video + mic audio only (no app audio)
  // App audio is written to a separate file for Mux compatibility
  private lazy var inputs: [AVAssetWriterInput] = [
    videoInput,
    microphoneInput,
  ]

  private let screenSize: CGSize
  private let screenScale: CGFloat

  public init(
    outputURL url: URL,
    audioOutputURL: URL? = nil,
    appAudioOutputURL: URL? = nil,
    assetWriterQueue queue: DispatchQueue = .init(label: "BroadcastSampleHandler.assetWriterQueue"),
    screenSize: CGSize,
    screenScale: CGFloat,
    separateAudioFile: Bool = false
  ) throws {
    assetWriterQueue = queue
    assetWriter = try .init(url: url, fileType: .mp4)
    assetWriter.shouldOptimizeForNetworkUse = true

    self.screenSize = screenSize
    self.screenScale = screenScale
    self.separateAudioFile = separateAudioFile
    self.audioOutputURL = audioOutputURL
    self.appAudioOutputURL = appAudioOutputURL

    // Initialize separate mic audio writer if needed
    if separateAudioFile, let audioURL = audioOutputURL {
      separateAudioWriter = try .init(url: audioURL, fileType: .m4a)
      separateAudioWriter?.shouldOptimizeForNetworkUse = true
    }

    // Initialize separate app audio writer if needed
    if separateAudioFile, let appAudioURL = appAudioOutputURL {
      appAudioWriter = try .init(url: appAudioURL, fileType: .m4a)
      appAudioWriter?.shouldOptimizeForNetworkUse = true
    }
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

      // Start separate mic audio writer if enabled
      if separateAudioFile, let audioWriter = separateAudioWriter {
        let audioStatus = audioWriter.status
        guard audioStatus == .unknown else {
          throw Error.wrongAssetWriterStatus(audioStatus)
        }
        try audioWriter.error.map { throw $0 }
        if audioWriter.canAdd(separateAudioInput) {
          audioWriter.add(separateAudioInput)
        }
        try audioWriter.error.map { throw $0 }
        audioWriter.startWriting()
        try audioWriter.error.map { throw $0 }
      }

      // Start separate app audio writer if enabled
      if separateAudioFile, let appWriter = appAudioWriter {
        let appAudioStatus = appWriter.status
        guard appAudioStatus == .unknown else {
          throw Error.wrongAssetWriterStatus(appAudioStatus)
        }
        try appWriter.error.map { throw $0 }
        if appWriter.canAdd(appAudioInput) {
          appWriter.add(appAudioInput)
        }
        try appWriter.error.map { throw $0 }
        appWriter.startWriting()
        try appWriter.error.map { throw $0 }
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
      // App audio goes to separate file only (not embedded in main video)
      if separateAudioFile {
        assetWriterQueue.sync {
          _ = captureAppAudioOutput(sampleBuffer)
        }
      }
      // Return early - don't write app audio to main video file
      return true
    case .audioMic:
      capture = captureMicrophoneOutput
      // Also write to separate mic audio file if enabled
      if separateAudioFile {
        assetWriterQueue.sync {
          _ = captureSeparateAudioOutput(sampleBuffer)
        }
      }
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

  /// Result containing video and optional separate audio URLs
  public struct FinishResult {
    public let videoURL: URL
    public let audioURL: URL?  // Mic audio file
    public let appAudioURL: URL?  // App/system audio file
  }

  public func finish() throws -> URL {
    let result = try finishWithAudio()
    return result.videoURL
  }

  public func finishWithAudio() throws -> FinishResult {
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

      // Finish separate mic audio writer if enabled
      var audioURL: URL? = nil
      if separateAudioFile, let audioWriter = separateAudioWriter {
        if separateAudioInput.isReadyForMoreMediaData {
          separateAudioInput.markAsFinished()
        }

        if audioWriter.status == .writing {
          let audioGroup = DispatchGroup()
          audioGroup.enter()

          var audioError: Swift.Error?
          audioWriter.finishWriting {
            defer { audioGroup.leave() }
            if let e = audioWriter.error {
              audioError = e
              return
            }
            if audioWriter.status != .completed {
              audioError = Error.wrongAssetWriterStatus(audioWriter.status)
            }
          }
          audioGroup.wait()

          if audioError == nil {
            audioURL = audioWriter.outputURL
          }
        }
      }

      // Finish separate app audio writer if enabled
      var appAudioURL: URL? = nil
      if separateAudioFile, let appWriter = appAudioWriter {
        if appAudioInput.isReadyForMoreMediaData {
          appAudioInput.markAsFinished()
        }

        if appWriter.status == .writing {
          let appAudioGroup = DispatchGroup()
          appAudioGroup.enter()

          var appAudioError: Swift.Error?
          appWriter.finishWriting {
            defer { appAudioGroup.leave() }
            if let e = appWriter.error {
              appAudioError = e
              return
            }
            if appWriter.status != .completed {
              appAudioError = Error.wrongAssetWriterStatus(appWriter.status)
            }
          }
          appAudioGroup.wait()

          if appAudioError == nil {
            appAudioURL = appWriter.outputURL
          }
        }
      }

      return FinishResult(
        videoURL: assetWriter.outputURL, audioURL: audioURL, appAudioURL: appAudioURL)
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

  fileprivate func startAudioSessionIfNeeded(sampleBuffer: CMSampleBuffer) {
    guard !audioAssetWriterSessionStarted, let audioWriter = separateAudioWriter else {
      return
    }

    let sourceTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    audioWriter.startSession(atSourceTime: sourceTime)
    audioAssetWriterSessionStarted = true
  }

  fileprivate func startAppAudioSessionIfNeeded(sampleBuffer: CMSampleBuffer) {
    guard !appAudioAssetWriterSessionStarted, let appWriter = appAudioWriter else {
      return
    }

    let sourceTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    appWriter.startSession(atSourceTime: sourceTime)
    appAudioAssetWriterSessionStarted = true
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

  fileprivate func captureSeparateAudioOutput(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard separateAudioFile, let audioWriter = separateAudioWriter else {
      return false
    }

    // Check if audio writer is still writing
    guard audioWriter.status == .writing else {
      debugPrint("separateAudioWriter is not writing, status: \(audioWriter.status.description)")
      return false
    }

    // Start session if needed
    startAudioSessionIfNeeded(sampleBuffer: sampleBuffer)

    guard separateAudioInput.isReadyForMoreMediaData else {
      debugPrint("separateAudioInput is not ready")
      return false
    }
    return separateAudioInput.append(sampleBuffer)
  }

  fileprivate func captureAppAudioOutput(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard separateAudioFile, let appWriter = appAudioWriter else {
      return false
    }

    // Check if app audio writer is still writing
    guard appWriter.status == .writing else {
      debugPrint("appAudioWriter is not writing, status: \(appWriter.status.description)")
      return false
    }

    // Start session if needed
    startAppAudioSessionIfNeeded(sampleBuffer: sampleBuffer)

    guard appAudioInput.isReadyForMoreMediaData else {
      debugPrint("appAudioInput is not ready")
      return false
    }
    return appAudioInput.append(sampleBuffer)
  }
}
