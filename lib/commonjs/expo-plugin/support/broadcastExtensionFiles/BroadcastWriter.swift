// MARK: Broadcast Writer

// Copied from the repo:
// https://github.com/romiroma/BroadcastWriter

import AVFoundation
import AudioToolbox
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

  // Shared session start time for audio/video sync
  // All writers use the same reference timestamp to stay in sync
  private var sessionStartTime: CMTime?

  // Track timestamps for padding audio to match video length
  private var lastVideoEndTime: CMTime = .zero
  private var lastVideoPTS: CMTime?
  private var lastVideoFrameDuration: CMTime = .zero
  private var lastMicEndTime: CMTime = .zero
  private var lastAppAudioEndTime: CMTime = .zero

  // Audio format info for generating silence padding
  private var micAudioFormatDescription: CMFormatDescription?
  private var appAudioFormatDescription: CMFormatDescription?
  private lazy var defaultAudioFormatDescription: CMFormatDescription? = {
    let fallbackSampleRate = audioSampleRate > 0 ? audioSampleRate : 48_000
    var asbd = AudioStreamBasicDescription(
      mSampleRate: fallbackSampleRate,
      mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 2,
      mFramesPerPacket: 1,
      mBytesPerFrame: 2,
      mChannelsPerFrame: 1,
      mBitsPerChannel: 16,
      mReserved: 0
    )
    var desc: CMFormatDescription?
    let status = CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: &asbd,
      layoutSize: 0,
      layout: nil,
      magicCookieSize: 0,
      magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &desc
    )
    if status != noErr {
      debugPrint("⚠️ Failed to create default audio format description: \(status)")
      return nil
    }
    return desc
  }()

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
    #if os(iOS)
      return AVAudioSession.sharedInstance().sampleRate
    #else
      return 48_000
    #endif
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
    // Calculate appropriate bitrate based on sample rate
    // AAC encoder rejects high bitrates for low sample rates (e.g. 128kbps at 24kHz)
    // Base: 64kbps for 44.1kHz mono, scaled proportionally
    let scaleFactor = audioSampleRate / 44100.0
    let bitRatePerChannel = 64000.0 * scaleFactor
    let calculatedBitRate = Int(bitRatePerChannel)
    let bitRate = max(min(calculatedBitRate, 128000), 24000)

    var audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: audioSampleRate,
      AVEncoderBitRateKey: bitRate,
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
    // Calculate appropriate bitrate based on sample rate
    // AAC encoder rejects high bitrates for low sample rates (e.g. 128kbps at 24kHz)
    // Base: 64kbps for 44.1kHz mono, scaled proportionally
    let scaleFactor = audioSampleRate / 44100.0
    let bitRatePerChannel = 64000.0 * scaleFactor
    let calculatedBitRate = Int(bitRatePerChannel)
    let bitRate = max(min(calculatedBitRate, 128000), 24000)

    var audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVNumberOfChannelsKey: 1,
      AVSampleRateKey: audioSampleRate,
      AVEncoderBitRateKey: bitRate,
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

    if sampleBufferType == .video {
      assetWriterQueue.sync {
        startSessionIfNeeded(sampleBuffer: sampleBuffer)
      }
    } else {
      let hasSessionStart = assetWriterQueue.sync { sessionStartTime != nil }
      if !hasSessionStart {
        debugPrint("⚠️ Audio sample received before video session start; dropping.")
        return false
      }
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

  /// Returns diagnostic info about the writer state for debugging
  public func getDiagnostics() -> String {
    return assetWriterQueue.sync {
      var info: [String] = []
      info.append("status=\(assetWriter.status.description)")
      if let error = assetWriter.error {
        info.append("error=\(error.localizedDescription)")
      }
      info.append("sessionStarted=\(assetWriterSessionStarted)")
      info.append("lastVideoPTS=\(lastVideoPTS?.seconds ?? -1)")
      info.append("lastVideoEndTime=\(lastVideoEndTime.seconds)")
      info.append("videoInputReady=\(videoInput.isReadyForMoreMediaData)")
      
      // Check output file
      let outputPath = assetWriter.outputURL.path
      let fileExists = FileManager.default.fileExists(atPath: outputPath)
      var fileSize: Int64 = 0
      if fileExists, let attrs = try? FileManager.default.attributesOfItem(atPath: outputPath) {
        fileSize = (attrs[.size] as? Int64) ?? 0
      }
      info.append("outputExists=\(fileExists)")
      info.append("outputSize=\(fileSize)")
      
      return info.joined(separator: ", ")
    }
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

  /// Returns true if the writer has received at least one video frame
  public var hasReceivedVideoFrames: Bool {
    return assetWriterQueue.sync { assetWriterSessionStarted }
  }

  public func finishWithAudio() throws -> FinishResult {
    return try assetWriterQueue.sync {
      // IMPORTANT: If no video frames were ever received, the session was never started.
      // AVAssetWriter will fail if we try to finish without starting a session.
      // In this case, cancel the writer and throw a specific error.
      guard assetWriterSessionStarted else {
        debugPrint("⚠️ BroadcastWriter: No video frames received, canceling writer")
        assetWriter.cancelWriting()
        // Also cancel audio writers
        separateAudioWriter?.cancelWriting()
        appAudioWriter?.cancelWriting()
        throw Error.wrongAssetWriterStatus(.cancelled)
      }

      let group: DispatchGroup = .init()

      // Pad audio files with silence to match video length
      if isPositiveTime(lastVideoEndTime) {
        padAudioToVideoLength()
      }

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
    // Store the reference timestamp for all writers to use
    sessionStartTime = sourceTime
    assetWriter.startSession(atSourceTime: sourceTime)
    assetWriterSessionStarted = true
  }

  fileprivate func startAudioSessionIfNeeded() {
    guard !audioAssetWriterSessionStarted, let audioWriter = separateAudioWriter,
      audioWriter.status == .writing
    else {
      return
    }

    // Always use the shared session start time for audio/video sync
    guard let startTime = sessionStartTime else {
      return
    }
    audioWriter.startSession(atSourceTime: startTime)
    audioAssetWriterSessionStarted = true
  }

  fileprivate func startAppAudioSessionIfNeeded() {
    guard !appAudioAssetWriterSessionStarted, let appWriter = appAudioWriter,
      appWriter.status == .writing
    else {
      return
    }

    // Always use the shared session start time for audio/video sync
    guard let startTime = sessionStartTime else {
      return
    }
    appWriter.startSession(atSourceTime: startTime)
    appAudioAssetWriterSessionStarted = true
  }

  fileprivate func captureVideoOutput(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard videoInput.isReadyForMoreMediaData else {
      debugPrint("videoInput is not ready")
      return false
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    var frameDuration = CMSampleBufferGetDuration(sampleBuffer)
    if !isPositiveTime(frameDuration), let lastPTS = lastVideoPTS {
      let delta = CMTimeSubtract(pts, lastPTS)
      if isPositiveTime(delta) {
        frameDuration = delta
      }
    }
    if !isPositiveTime(frameDuration) {
      frameDuration =
        isPositiveTime(lastVideoFrameDuration)
        ? lastVideoFrameDuration
        : CMTime(value: 1, timescale: 60)
    }
    let endTime = isPositiveTime(frameDuration) ? CMTimeAdd(pts, frameDuration) : pts
    let appended = videoInput.append(sampleBuffer)
    if appended {
      if isPositiveTime(frameDuration) {
        lastVideoFrameDuration = frameDuration
      }
      lastVideoPTS = pts
      if CMTimeCompare(endTime, lastVideoEndTime) > 0 {
        lastVideoEndTime = endTime
      }
    }
    return appended
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
    guard let startTime = sessionStartTime else {
      debugPrint("⚠️ Mic audio before video session start; dropping.")
      return false
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if CMTimeCompare(pts, startTime) < 0 {
      debugPrint("⚠️ Mic audio timestamp precedes video start; dropping.")
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

    guard let startTime = sessionStartTime else {
      debugPrint("⚠️ Mic audio before video session start; dropping.")
      return false
    }

    // Start session if needed
    startAudioSessionIfNeeded()

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if CMTimeCompare(pts, startTime) < 0 {
      debugPrint("⚠️ Mic audio timestamp precedes video start; dropping.")
      return false
    }

    // Track format for padding
    if micAudioFormatDescription == nil {
      micAudioFormatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    }
    let duration = audioSampleDuration(sampleBuffer, formatDescription: micAudioFormatDescription)
    let endTime = isPositiveTime(duration) ? CMTimeAdd(pts, duration) : pts

    guard separateAudioInput.isReadyForMoreMediaData else {
      debugPrint("separateAudioInput is not ready")
      return false
    }
    let appended = separateAudioInput.append(sampleBuffer)
    if appended, CMTimeCompare(endTime, lastMicEndTime) > 0 {
      lastMicEndTime = endTime
    }
    return appended
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

    guard let startTime = sessionStartTime else {
      debugPrint("⚠️ App audio before video session start; dropping.")
      return false
    }

    // Start session if needed
    startAppAudioSessionIfNeeded()

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    if CMTimeCompare(pts, startTime) < 0 {
      debugPrint("⚠️ App audio timestamp precedes video start; dropping.")
      return false
    }

    // Track format for padding
    if appAudioFormatDescription == nil {
      appAudioFormatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    }
    let duration = audioSampleDuration(sampleBuffer, formatDescription: appAudioFormatDescription)
    let endTime = isPositiveTime(duration) ? CMTimeAdd(pts, duration) : pts

    guard appAudioInput.isReadyForMoreMediaData else {
      debugPrint("appAudioInput is not ready")
      return false
    }
    let appended = appAudioInput.append(sampleBuffer)
    if appended, CMTimeCompare(endTime, lastAppAudioEndTime) > 0 {
      lastAppAudioEndTime = endTime
    }
    return appended
  }

  // MARK: - Audio Padding

  /// Pads audio files with silence to match video length
  fileprivate func padAudioToVideoLength() {
    let videoEndTime = lastVideoEndTime
    guard isPositiveTime(videoEndTime), let sessionStartTime = sessionStartTime else {
      debugPrint("📐 Padding skipped: missing video end time or session start time")
      return
    }
    debugPrint("📐 Video end time: \(videoEndTime.seconds)s")

    // Pad mic audio if it's shorter than video
    if separateAudioFile, let audioWriter = separateAudioWriter, audioWriter.status == .writing {
      if !audioAssetWriterSessionStarted {
        audioWriter.startSession(atSourceTime: sessionStartTime)
        audioAssetWriterSessionStarted = true
      }
      let micStartTime = isPositiveTime(lastMicEndTime) ? lastMicEndTime : sessionStartTime
      if CMTimeCompare(micStartTime, videoEndTime) < 0 {
        let silenceDuration = CMTimeSubtract(videoEndTime, micStartTime)
        debugPrint("📐 Padding mic audio with \(silenceDuration.seconds)s of silence")
        appendSilence(
          to: separateAudioInput,
          from: micStartTime,
          duration: silenceDuration,
          formatDescription: micAudioFormatDescription ?? defaultAudioFormatDescription
        )
      } else {
        debugPrint("📐 Mic audio already matches/exceeds video length; no padding needed")
      }
    } else {
      debugPrint("📐 Mic audio padding skipped: no separate mic writer or not writing")
    }

    // Pad app audio if it's shorter than video
    if separateAudioFile, let appWriter = appAudioWriter, appWriter.status == .writing {
      if !appAudioAssetWriterSessionStarted {
        appWriter.startSession(atSourceTime: sessionStartTime)
        appAudioAssetWriterSessionStarted = true
      }
      let appStartTime =
        isPositiveTime(lastAppAudioEndTime) ? lastAppAudioEndTime : sessionStartTime
      if CMTimeCompare(appStartTime, videoEndTime) < 0 {
        let silenceDuration = CMTimeSubtract(videoEndTime, appStartTime)
        debugPrint("📐 Padding app audio with \(silenceDuration.seconds)s of silence")
        appendSilence(
          to: appAudioInput,
          from: appStartTime,
          duration: silenceDuration,
          formatDescription: appAudioFormatDescription ?? defaultAudioFormatDescription
        )
      } else {
        debugPrint("📐 App audio already matches/exceeds video length; no padding needed")
      }
    } else {
      debugPrint("📐 App audio padding skipped: no app writer or not writing")
    }
  }

  /// Appends silent audio samples to an input
  fileprivate func appendSilence(
    to input: AVAssetWriterInput,
    from startTime: CMTime,
    duration: CMTime,
    formatDescription: CMFormatDescription?
  ) {
    guard isPositiveTime(duration) else {
      return
    }
    let formatDesc = formatDescription ?? defaultAudioFormatDescription
    guard let formatDesc else {
      debugPrint("⚠️ Cannot pad audio: no format description available")
      return
    }

    // Get audio format details
    guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else {
      debugPrint("⚠️ Cannot pad audio: unable to get audio stream description")
      return
    }

    let sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : audioSampleRate
    let channelCount = max(Int(asbd.mChannelsPerFrame), 1)
    let bitsPerChannel = asbd.mBitsPerChannel > 0 ? Int(asbd.mBitsPerChannel) : 16
    let bytesPerSample = max(bitsPerChannel / 8, 1)
    let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
    let bytesPerFrame: Int = {
      if asbd.mBytesPerFrame > 0 {
        return Int(asbd.mBytesPerFrame)
      }
      let channelsForFrame = isNonInterleaved ? 1 : channelCount
      return bytesPerSample * channelsForFrame
    }()

    let timeScale = CMTimeScale(sampleRate.rounded())
    guard timeScale > 0 else {
      debugPrint("⚠️ Cannot pad audio: invalid sample rate \(sampleRate)")
      return
    }

    // Calculate samples needed (generate in chunks to avoid huge allocations)
    let samplesNeededTime = CMTimeConvertScale(
      duration, timescale: timeScale, method: .roundHalfAwayFromZero)
    var samplesRemaining = Int(samplesNeededTime.value)
    guard samplesRemaining > 0 else {
      return
    }

    let samplesPerChunk = 1024
    var currentTime = startTime

    while samplesRemaining > 0 {
      guard waitForInputReady(input, timeout: 0.5) else {
        debugPrint("⚠️ Input not ready while padding audio; remaining samples: \(samplesRemaining)")
        break
      }

      let samplesToWrite = min(samplesRemaining, samplesPerChunk)
      let bufferSize = samplesToWrite * bytesPerFrame
      let bufferCount = isNonInterleaved ? channelCount : 1

      // Allocate AudioBufferList
      let audioBufferList = AudioBufferList.allocate(maximumBuffers: bufferCount)
      audioBufferList.unsafeMutablePointer.pointee.mNumberBuffers = UInt32(bufferCount)

      var bufferPointers: [UnsafeMutableRawPointer] = []
      bufferPointers.reserveCapacity(bufferCount)

      for i in 0..<bufferCount {
        guard let silentData = calloc(bufferSize, 1) else {
          break
        }
        bufferPointers.append(silentData)

        audioBufferList[i].mNumberChannels = isNonInterleaved ? 1 : UInt32(channelCount)
        audioBufferList[i].mDataByteSize = UInt32(bufferSize)
        audioBufferList[i].mData = silentData
      }
      defer {
        bufferPointers.forEach { free($0) }
        audioBufferList.unsafeMutablePointer.deallocate()
      }

      if bufferPointers.count != bufferCount {
        debugPrint("⚠️ Failed to allocate silent audio buffers")
        break
      }

      // Create CMSampleBuffer
      var sampleBuffer: CMSampleBuffer?
      var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: timeScale),
        presentationTimeStamp: currentTime,
        decodeTimeStamp: .invalid
      )

      let status = CMSampleBufferCreate(
        allocator: kCFAllocatorDefault,
        dataBuffer: nil,
        dataReady: false,
        makeDataReadyCallback: nil,
        refcon: nil,
        formatDescription: formatDesc,
        sampleCount: samplesToWrite,
        sampleTimingEntryCount: 1,
        sampleTimingArray: &timing,
        sampleSizeEntryCount: 0,
        sampleSizeArray: nil,
        sampleBufferOut: &sampleBuffer
      )

      guard status == noErr, let buffer = sampleBuffer else {
        debugPrint("⚠️ Failed to create silent sample buffer: \(status)")
        break
      }

      // Set audio buffer data
      let setStatus = CMSampleBufferSetDataBufferFromAudioBufferList(
        buffer,
        blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault,
        flags: 0,
        bufferList: audioBufferList.unsafePointer
      )

      guard setStatus == noErr else {
        debugPrint("⚠️ Failed to set audio buffer data: \(setStatus)")
        break
      }

      // Append to writer
      if !input.append(buffer) {
        debugPrint("⚠️ Failed to append silent audio buffer")
        break
      }

      // Advance time
      let chunkDuration = CMTime(value: CMTimeValue(samplesToWrite), timescale: timeScale)
      currentTime = CMTimeAdd(currentTime, chunkDuration)
      samplesRemaining -= samplesToWrite
    }

    debugPrint("📐 Finished padding audio, remaining samples: \(samplesRemaining)")
  }

  // MARK: - Helpers

  fileprivate func isPositiveTime(_ time: CMTime) -> Bool {
    time.isValid && !time.isIndefinite && CMTimeCompare(time, .zero) > 0
  }

  fileprivate func audioSampleDuration(
    _ sampleBuffer: CMSampleBuffer,
    formatDescription: CMFormatDescription?
  ) -> CMTime {
    let duration = CMSampleBufferGetDuration(sampleBuffer)
    if isPositiveTime(duration) {
      return duration
    }

    if let formatDescription,
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription)?.pointee
    {
      let sampleRate = asbd.mSampleRate > 0 ? asbd.mSampleRate : audioSampleRate
      if sampleRate > 0 {
        let sampleCount = CMSampleBufferGetNumSamples(sampleBuffer)
        let timeScale = CMTimeScale(sampleRate.rounded())
        if timeScale > 0 {
          return CMTime(value: CMTimeValue(sampleCount), timescale: timeScale)
        }
      }
    }
    return .zero
  }

  fileprivate func waitForInputReady(_ input: AVAssetWriterInput, timeout: TimeInterval) -> Bool {
    let start = Date()
    while !input.isReadyForMoreMediaData {
      if Date().timeIntervalSince(start) >= timeout {
        return false
      }
      Thread.sleep(forTimeInterval: 0.005)
    }
    return true
  }
}
