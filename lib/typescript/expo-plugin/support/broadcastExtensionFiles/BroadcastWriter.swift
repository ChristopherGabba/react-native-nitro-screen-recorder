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

  // Early audio buffering: hold audio samples until video starts
  // This prevents dropping audio that arrives before the first video frame
  private var earlyMicBuffers: [CMSampleBuffer] = []
  private var earlyAppAudioBuffers: [CMSampleBuffer] = []
  private let maxEarlyBufferCount = 500  // ~10 seconds at 48kHz with 1024-sample packets
  private var earlyBuffersDropped: Int = 0

  // Track timestamps for padding audio to match video length
  private var lastVideoEndTime: CMTime = .zero
  private var lastVideoPTS: CMTime?
  private var lastVideoFrameDuration: CMTime = .zero
  private var lastMicEndTime: CMTime = .zero
  private var lastAppAudioEndTime: CMTime = .zero

  // PTS ranges per audio stream (min/max of appended samples)
  private var micPtsMin: CMTime?
  private var micPtsMax: CMTime?
  private var separateMicPtsMin: CMTime?
  private var separateMicPtsMax: CMTime?
  private var appAudioPtsMin: CMTime?
  private var appAudioPtsMax: CMTime?

  // Audio format info for generating silence padding
  private var micAudioFormatDescription: CMFormatDescription?
  private var appAudioFormatDescription: CMFormatDescription?

  // Backpressure metrics
  private var micBackpressureHits: Int = 0
  private var micBackpressureDrops: Int = 0
  private var separateAudioBackpressureHits: Int = 0
  private var separateAudioBackpressureDrops: Int = 0
  private var appAudioBackpressureHits: Int = 0
  private var appAudioBackpressureDrops: Int = 0
  private var videoBackpressureHits: Int = 0
  private var videoBackpressureDrops: Int = 0

  // Audio/video sync offset tracking
  private let timingOffsetThreshold = CMTime(value: 4, timescale: 100)  // 40ms
  private let timingOffsetMax = CMTime(value: 3, timescale: 1)  // 3s
  // Positive values delay audio to counter slight lead on playback
  private let audioLeadCompensation = CMTime(value: 20, timescale: 1000)  // 20ms
  private var micTimingOffset: CMTime = .zero
  private var micTimingOffsetResolved = false
  private var appAudioTimingOffset: CMTime = .zero
  private var appAudioTimingOffsetResolved = false
  private var observedFirstMicDeltaToVideo: Double?
  private var observedFirstAppAudioDeltaToVideo: Double?
  private var micAdjustmentAppliedCount: Int = 0
  private var appAudioAdjustmentAppliedCount: Int = 0
  private var micAdjustmentAppliedSeconds: Double = 0
  private var appAudioAdjustmentAppliedSeconds: Double = 0

  // Audio session change tracking (route/sample rate shifts during a chunk)
  private let audioSessionCheckInterval: TimeInterval = 0.5
  private var lastAudioSessionCheckTime = Date.distantPast
  private var lastAudioRouteSignature: String?
  private var lastAudioSampleRate: Double = 0
  private var lastAudioIOBufferDuration: TimeInterval = 0
  private var audioSessionChangeCount: Int = 0

  // Low power mode tuning (reduce audio drops under CPU pressure)
  private var isLowPowerModeEnabled: Bool {
    if #available(iOS 9.0, *) {
      return ProcessInfo.processInfo.isLowPowerModeEnabled
    }
    return false
  }

  private var audioBackpressureTimeout: TimeInterval {
    return isLowPowerModeEnabled ? 0.1 : 0.05
  }

  private var inputReadyPollInterval: TimeInterval {
    return isLowPowerModeEnabled ? 0.01 : 0.005
  }

  // MARK: - Audio Metrics

  // First PTS tracking for sync analysis
  private var firstVideoPTS: CMTime?
  private var firstMicPTS: CMTime?
  private var firstAppAudioPTS: CMTime?

  // Sample counts
  private var totalVideoFrames: Int = 0
  private var totalMicSamples: Int = 0
  private var totalAppAudioSamples: Int = 0
  private var totalSeparateAudioSamples: Int = 0

  // Drop counts by reason
  private var micDroppedBeforeSession: Int = 0
  private var micDroppedPTSBelowStart: Int = 0
  private var appAudioDroppedBeforeSession: Int = 0
  private var appAudioDroppedPTSBelowStart: Int = 0

  // Monotonicity tracking
  private var lastMicPTS: CMTime?
  private var lastAppAudioPTS: CMTime?
  private var micMonotonicityViolations: Int = 0
  private var appAudioMonotonicityViolations: Int = 0
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
      AVVideoExpectedSourceFrameRateKey: 30.nsNumber
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
      // Buffer early audio until video starts instead of dropping
      let hasSessionStart = assetWriterQueue.sync { sessionStartTime != nil }
      if !hasSessionStart {
        return assetWriterQueue.sync {
          bufferEarlyAudio(sampleBuffer, type: sampleBufferType)
        }
      }
    }

    switch sampleBufferType {
    case .video:
      return assetWriterQueue.sync {
        captureVideoOutput(sampleBuffer)
      }
    case .audioApp:
      // App audio goes to separate file only (not embedded in main video)
      return assetWriterQueue.sync {
        let adjustedBuffer = adjustedAudioSampleBufferIfNeeded(
          sampleBuffer,
          audioType: .audioApp
        )
        if separateAudioFile {
          _ = captureAppAudioOutput(adjustedBuffer)
        }
        // Return early - don't write app audio to main video file
        return true
      }
    case .audioMic:
      // Also write to separate mic audio file if enabled
      return assetWriterQueue.sync {
        let adjustedBuffer = adjustedAudioSampleBufferIfNeeded(
          sampleBuffer,
          audioType: .audioMic
        )
        if separateAudioFile {
          _ = captureSeparateAudioOutput(adjustedBuffer)
        }
        return captureMicrophoneOutput(adjustedBuffer)
      }
    @unknown default:
      debugPrint(#file, "Unknown type of sample buffer, \(sampleBufferType)")
      return false
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
      info.append("sessionStartTime=\(sessionStartTime?.seconds ?? -1)")
      info.append("lastVideoPTS=\(lastVideoPTS?.seconds ?? -1)")
      info.append("lastVideoEndTime=\(lastVideoEndTime.seconds)")
      info.append("lastMicEndTime=\(lastMicEndTime.seconds)")
      info.append("lastAppAudioEndTime=\(lastAppAudioEndTime.seconds)")
      info.append("videoInputReady=\(videoInput.isReadyForMoreMediaData)")

      // Sample counts
      info.append("totalVideoFrames=\(totalVideoFrames)")
      info.append("totalMicSamples=\(totalMicSamples)")
      info.append("totalSeparateAudioSamples=\(totalSeparateAudioSamples)")
      info.append("totalAppAudioSamples=\(totalAppAudioSamples)")

      // First PTS deltas (audio vs video sync)
      if let firstVideo = firstVideoPTS {
        if let firstMic = firstMicPTS {
          let delta = CMTimeSubtract(firstMic, firstVideo).seconds
          info.append("firstMicDeltaToVideo=\(String(format: "%.3f", delta))s")
        }
        if let firstApp = firstAppAudioPTS {
          let delta = CMTimeSubtract(firstApp, firstVideo).seconds
          info.append("firstAppAudioDeltaToVideo=\(String(format: "%.3f", delta))s")
        }
      }
      if let observedDelta = observedFirstMicDeltaToVideo {
        info.append("observedFirstMicDeltaToVideo=\(String(format: "%.3f", observedDelta))s")
      }
      if let observedDelta = observedFirstAppAudioDeltaToVideo {
        info.append("observedFirstAppAudioDeltaToVideo=\(String(format: "%.3f", observedDelta))s")
      }
      info.append("micTimingOffset=\(String(format: "%.3f", micTimingOffset.seconds))s")
      info.append("appAudioTimingOffset=\(String(format: "%.3f", appAudioTimingOffset.seconds))s")
      info.append(
        "audioLeadCompensation=\(String(format: "%.3f", audioLeadCompensation.seconds))s"
      )
      info.append("audioSessionChangeCount=\(audioSessionChangeCount)")

      // Duration comparison (audio vs video)
      let videoDuration =
        isPositiveTime(lastVideoEndTime) && sessionStartTime != nil
        ? CMTimeSubtract(lastVideoEndTime, sessionStartTime!).seconds : 0
      let micDuration =
        isPositiveTime(lastMicEndTime) && sessionStartTime != nil
        ? CMTimeSubtract(lastMicEndTime, sessionStartTime!).seconds : 0
      let appAudioDuration =
        isPositiveTime(lastAppAudioEndTime) && sessionStartTime != nil
        ? CMTimeSubtract(lastAppAudioEndTime, sessionStartTime!).seconds : 0
      info.append("videoDuration=\(String(format: "%.2f", videoDuration))s")
      info.append("micDuration=\(String(format: "%.2f", micDuration))s")
      info.append("appAudioDuration=\(String(format: "%.2f", appAudioDuration))s")

      // Backpressure metrics (hits/drops)
      info.append("videoBackpressure=\(videoBackpressureHits)/\(videoBackpressureDrops)")
      info.append("micBackpressure=\(micBackpressureHits)/\(micBackpressureDrops)")
      info.append(
        "separateAudioBackpressure=\(separateAudioBackpressureHits)/\(separateAudioBackpressureDrops)"
      )
      info.append("appAudioBackpressure=\(appAudioBackpressureHits)/\(appAudioBackpressureDrops)")

      info.append("lowPowerMode=\(isLowPowerModeEnabled)")
      info.append("audioBackpressureTimeout=\(String(format: "%.3f", audioBackpressureTimeout))s")

      // Drop counts by reason
      info.append("micDroppedBeforeSession=\(micDroppedBeforeSession)")
      info.append("micDroppedPTSBelowStart=\(micDroppedPTSBelowStart)")
      info.append("appAudioDroppedBeforeSession=\(appAudioDroppedBeforeSession)")
      info.append("appAudioDroppedPTSBelowStart=\(appAudioDroppedPTSBelowStart)")

      // Monotonicity violations
      info.append("micMonotonicityViolations=\(micMonotonicityViolations)")
      info.append("appAudioMonotonicityViolations=\(appAudioMonotonicityViolations)")

      // Early buffer metrics
      info.append("earlyBuffersDropped=\(earlyBuffersDropped)")

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

  /// Returns audio metrics as a dictionary for structured logging/Sentry
  public func getAudioMetrics() -> [String: Any] {
    return assetWriterQueue.sync {
      var metrics: [String: Any] = [:]

      // Timestamps
      metrics["sessionStartTime"] = sessionStartTime?.seconds ?? -1
      metrics["firstVideoPTS"] = firstVideoPTS?.seconds ?? -1
      metrics["firstMicPTS"] = firstMicPTS?.seconds ?? -1
      metrics["firstAppAudioPTS"] = firstAppAudioPTS?.seconds ?? -1

      // Sample counts
      metrics["totalVideoFrames"] = totalVideoFrames
      metrics["totalMicSamples"] = totalMicSamples
      metrics["totalSeparateAudioSamples"] = totalSeparateAudioSamples
      metrics["totalAppAudioSamples"] = totalAppAudioSamples

      // Durations
      let videoDuration =
        isPositiveTime(lastVideoEndTime) && sessionStartTime != nil
        ? CMTimeSubtract(lastVideoEndTime, sessionStartTime!).seconds : 0
      let micDuration =
        isPositiveTime(lastMicEndTime) && sessionStartTime != nil
        ? CMTimeSubtract(lastMicEndTime, sessionStartTime!).seconds : 0
      let appAudioDuration =
        isPositiveTime(lastAppAudioEndTime) && sessionStartTime != nil
        ? CMTimeSubtract(lastAppAudioEndTime, sessionStartTime!).seconds : 0
      metrics["videoDuration"] = videoDuration
      metrics["micDuration"] = micDuration
      metrics["appAudioDuration"] = appAudioDuration

      // PTS deltas (sync indicators)
      if let firstVideo = firstVideoPTS {
        if let firstMic = firstMicPTS {
          metrics["firstMicDeltaToVideo"] = CMTimeSubtract(firstMic, firstVideo).seconds
        }
        if let firstApp = firstAppAudioPTS {
          metrics["firstAppAudioDeltaToVideo"] = CMTimeSubtract(firstApp, firstVideo).seconds
        }
      }
      if let observedDelta = observedFirstMicDeltaToVideo {
        metrics["observedFirstMicDeltaToVideo"] = observedDelta
      }
      if let observedDelta = observedFirstAppAudioDeltaToVideo {
        metrics["observedFirstAppAudioDeltaToVideo"] = observedDelta
      }
      metrics["micTimingOffset"] = micTimingOffset.seconds
      metrics["appAudioTimingOffset"] = appAudioTimingOffset.seconds
      metrics["audioLeadCompensationSeconds"] = audioLeadCompensation.seconds
      metrics["micAdjustmentApplied"] = micAdjustmentAppliedCount > 0
      metrics["micAdjustmentAppliedCount"] = micAdjustmentAppliedCount
      metrics["micAdjustmentAppliedSeconds"] = micAdjustmentAppliedSeconds
      metrics["appAudioAdjustmentApplied"] = appAudioAdjustmentAppliedCount > 0
      metrics["appAudioAdjustmentAppliedCount"] = appAudioAdjustmentAppliedCount
      metrics["appAudioAdjustmentAppliedSeconds"] = appAudioAdjustmentAppliedSeconds

      // Backpressure
      metrics["videoBackpressureHits"] = videoBackpressureHits
      metrics["videoBackpressureDrops"] = videoBackpressureDrops
      metrics["micBackpressureHits"] = micBackpressureHits
      metrics["micBackpressureDrops"] = micBackpressureDrops
      metrics["separateAudioBackpressureHits"] = separateAudioBackpressureHits
      metrics["separateAudioBackpressureDrops"] = separateAudioBackpressureDrops
      metrics["appAudioBackpressureHits"] = appAudioBackpressureHits
      metrics["appAudioBackpressureDrops"] = appAudioBackpressureDrops

      metrics["lowPowerModeEnabled"] = isLowPowerModeEnabled
      metrics["audioBackpressureTimeout"] = audioBackpressureTimeout

      // Drops by reason
      metrics["micDroppedBeforeSession"] = micDroppedBeforeSession
      metrics["micDroppedPTSBelowStart"] = micDroppedPTSBelowStart
      metrics["appAudioDroppedBeforeSession"] = appAudioDroppedBeforeSession
      metrics["appAudioDroppedPTSBelowStart"] = appAudioDroppedPTSBelowStart
      metrics["earlyBuffersDropped"] = earlyBuffersDropped

      // Monotonicity
      metrics["micMonotonicityViolations"] = micMonotonicityViolations
      metrics["appAudioMonotonicityViolations"] = appAudioMonotonicityViolations

      metrics["micPtsMin"] = micPtsMin?.seconds ?? -1
      metrics["micPtsMax"] = micPtsMax?.seconds ?? -1
      metrics["separateMicPtsMin"] = separateMicPtsMin?.seconds ?? -1
      metrics["separateMicPtsMax"] = separateMicPtsMax?.seconds ?? -1
      metrics["appAudioPtsMin"] = appAudioPtsMin?.seconds ?? -1
      metrics["appAudioPtsMax"] = appAudioPtsMax?.seconds ?? -1

      // Writer status
      metrics["writerStatus"] = assetWriter.status.description
      metrics["sessionStarted"] = assetWriterSessionStarted
      metrics["audioSessionChangeCount"] = audioSessionChangeCount

      #if os(iOS)
        let audioSession = AVAudioSession.sharedInstance()
        let route = audioSession.currentRoute
        metrics["audioSessionSampleRate"] = audioSession.sampleRate
        metrics["audioInputLatency"] = audioSession.inputLatency
        metrics["audioOutputLatency"] = audioSession.outputLatency
        metrics["audioIOBufferDuration"] = audioSession.ioBufferDuration
        metrics["audioRouteInputs"] = route.inputs.map {
          "\($0.portType.rawValue):\($0.portName)"
        }
        metrics["audioRouteOutputs"] = route.outputs.map {
          "\($0.portType.rawValue):\($0.portName)"
        }
        if let preferredInput = audioSession.preferredInput {
          metrics["audioPreferredInput"] =
            "\(preferredInput.portType.rawValue):\(preferredInput.portName)"
        }
      #endif

      return metrics
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

      // Pad audio files with silenne to match video length
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

  /// Buffers early audio samples that arrive before video starts
  fileprivate func bufferEarlyAudio(_ sampleBuffer: CMSampleBuffer, type: RPSampleBufferType)
    -> Bool
  {
    // Retain the sample buffer for later use
    if type == .audioMic {
      if earlyMicBuffers.count < maxEarlyBufferCount {
        earlyMicBuffers.append(sampleBuffer)
        debugPrint("📦 Buffered early mic audio (\(earlyMicBuffers.count) samples)")
        return true
      } else {
        earlyBuffersDropped += 1
        debugPrint(
          "⚠️ Early mic buffer full, dropping audio sample (dropped: \(earlyBuffersDropped))")
        return false
      }
    } else if type == .audioApp {
      if earlyAppAudioBuffers.count < maxEarlyBufferCount {
        earlyAppAudioBuffers.append(sampleBuffer)
        debugPrint("📦 Buffered early app audio (\(earlyAppAudioBuffers.count) samples)")
        return true
      } else {
        earlyBuffersDropped += 1
        debugPrint(
          "⚠️ Early app buffer full, dropping audio sample (dropped: \(earlyBuffersDropped))")
        return false
      }
    }
    return false
  }

  /// Flushes buffered early audio after video session starts
  fileprivate func flushEarlyAudioBuffers() {
    guard let startTime = sessionStartTime else { return }

    // Small tolerance: allow audio up to 100ms before video start
    let tolerance = CMTime(value: 1, timescale: 10)  // 100ms
    let adjustedStartTime = CMTimeSubtract(startTime, tolerance)

    // Flush mic audio buffers
    let micCount = earlyMicBuffers.count
    var micFlushed = 0
    var micDropped = 0
    for buffer in earlyMicBuffers {
      let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
      // Only flush if PTS is within tolerance of session start
      if CMTimeCompare(pts, adjustedStartTime) >= 0 {
        let adjusted = adjustedAudioSampleBufferIfNeeded(buffer, audioType: .audioMic)
        if captureMicrophoneOutput(adjusted) {
          micFlushed += 1
        }
        if separateAudioFile {
          _ = captureSeparateAudioOutput(adjusted)
        }
      } else {
        micDropped += 1
      }
    }
    if micCount > 0 {
      debugPrint(
        "📦 Flushed \(micFlushed)/\(micCount) early mic buffers (dropped \(micDropped) too early)")
    }
    earlyMicBuffers.removeAll()

    // Flush app audio buffers
    let appCount = earlyAppAudioBuffers.count
    var appFlushed = 0
    var appDropped = 0
    for buffer in earlyAppAudioBuffers {
      let pts = CMSampleBufferGetPresentationTimeStamp(buffer)
      if CMTimeCompare(pts, adjustedStartTime) >= 0 {
        if separateAudioFile {
          let adjusted = adjustedAudioSampleBufferIfNeeded(buffer, audioType: .audioApp)
          if captureAppAudioOutput(adjusted) {
            appFlushed += 1
          }
        }
      } else {
        appDropped += 1
      }
    }
    if appCount > 0 {
      debugPrint(
        "📦 Flushed \(appFlushed)/\(appCount) early app audio buffers (dropped \(appDropped) too early)"
      )
    }
    earlyAppAudioBuffers.removeAll()

    if earlyBuffersDropped > 0 {
      debugPrint("⚠️ Total early audio buffers dropped due to full buffer: \(earlyBuffersDropped)")
    }
  }

  fileprivate func startSessionIfNeeded(sampleBuffer: CMSampleBuffer) {
    guard !assetWriterSessionStarted else {
      return
    }

    let sourceTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    // Check if we have early audio that should adjust our start time
    // Use the earliest timestamp between video and buffered audio
    var effectiveStartTime = sourceTime
    if let earliestMic = earlyMicBuffers.first {
      let micPTS = CMSampleBufferGetPresentationTimeStamp(earliestMic)
      if CMTimeCompare(micPTS, effectiveStartTime) < 0 {
        effectiveStartTime = micPTS
        debugPrint("📦 Adjusted session start to earliest mic audio: \(effectiveStartTime.seconds)s")
      }
    }
    if let earliestApp = earlyAppAudioBuffers.first {
      let appPTS = CMSampleBufferGetPresentationTimeStamp(earliestApp)
      if CMTimeCompare(appPTS, effectiveStartTime) < 0 {
        effectiveStartTime = appPTS
        debugPrint("📦 Adjusted session start to earliest app audio: \(effectiveStartTime.seconds)s")
      }
    }

    // Store the reference timestamp for all writers to use
    sessionStartTime = effectiveStartTime
    assetWriter.startSession(atSourceTime: effectiveStartTime)
    assetWriterSessionStarted = true
    if firstVideoPTS == nil {
      firstVideoPTS = sourceTime
      debugPrint("📊 First video PTS: \(sourceTime.seconds)s")
    }
    debugPrint(
      "🎬 Session started at \(effectiveStartTime.seconds)s (video PTS: \(sourceTime.seconds)s)")

    // Flush buffered early audio now that session has started
    flushEarlyAudioBuffers()
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
    if !videoInput.isReadyForMoreMediaData {
      videoBackpressureHits += 1
      // Brief wait for video - critical for sync
      if !waitForInputReady(videoInput, timeout: 0.05) {
        videoBackpressureDrops += 1
        debugPrint(
          "⚠️ videoInput backpressure drop (hits: \(videoBackpressureHits), drops: \(videoBackpressureDrops))"
        )
        return false
      }
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    // Track first video PTS for sync analysis
    if firstVideoPTS == nil {
      firstVideoPTS = pts
      debugPrint("📊 First video PTS: \(pts.seconds)s")
    }

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
      totalVideoFrames += 1
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
    if !microphoneInput.isReadyForMoreMediaData {
      micBackpressureHits += 1
      // Brief wait for audio - avoid blocking too long
      if !waitForInputReady(microphoneInput, timeout: audioBackpressureTimeout) {
        micBackpressureDrops += 1
        debugPrint(
          "⚠️ microphoneInput backpressure drop (hits: \(micBackpressureHits), drops: \(micBackpressureDrops))"
        )
        return false
      }
    }
    guard let startTime = sessionStartTime else {
      micDroppedBeforeSession += 1
      debugPrint(
        "⚠️ Mic audio before video session start; dropping. (count: \(micDroppedBeforeSession))")
      return false
    }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    // Track first mic PTS and monotonicity
    if firstMicPTS == nil {
      firstMicPTS = pts
      let deltaToVideo = firstVideoPTS != nil ? CMTimeSubtract(pts, firstVideoPTS!).seconds : 0
      debugPrint("📊 First mic PTS: \(pts.seconds)s (delta to video: \(deltaToVideo)s)")
    }
    if let prevPTS = lastMicPTS, CMTimeCompare(pts, prevPTS) < 0 {
      micMonotonicityViolations += 1
      debugPrint(
        "⚠️ Mic PTS monotonicity violation: \(pts.seconds)s < \(prevPTS.seconds)s (count: \(micMonotonicityViolations))"
      )
    }
    lastMicPTS = pts

    // Allow small tolerance (100ms) for audio slightly before session start
    let tolerance = CMTime(value: 1, timescale: 10)
    let adjustedStartTime = CMTimeSubtract(startTime, tolerance)
    if CMTimeCompare(pts, adjustedStartTime) < 0 {
      micDroppedPTSBelowStart += 1
      debugPrint(
        "⚠️ Mic audio timestamp \(pts.seconds)s precedes adjusted start \(adjustedStartTime.seconds)s; dropping. (count: \(micDroppedPTSBelowStart))"
      )
      return false
    }
    let appended = microphoneInput.append(sampleBuffer)
    if appended {
      totalMicSamples += 1
      updatePtsRange(pts, min: &micPtsMin, max: &micPtsMax)
    }
    return appended
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
    // Allow small tolerance (100ms) for audio slightly before session start
    let tolerance = CMTime(value: 1, timescale: 10)
    let adjustedStartTime = CMTimeSubtract(startTime, tolerance)
    if CMTimeCompare(pts, adjustedStartTime) < 0 {
      debugPrint(
        "⚠️ Separate mic audio timestamp \(pts.seconds)s precedes adjusted start \(adjustedStartTime.seconds)s; dropping."
      )
      return false
    }

    // Track format for padding
    if micAudioFormatDescription == nil {
      micAudioFormatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    }
    let duration = audioSampleDuration(sampleBuffer, formatDescription: micAudioFormatDescription)
    let endTime = isPositiveTime(duration) ? CMTimeAdd(pts, duration) : pts

    if !separateAudioInput.isReadyForMoreMediaData {
      separateAudioBackpressureHits += 1
      // Brief wait for separate audio
      if !waitForInputReady(separateAudioInput, timeout: audioBackpressureTimeout) {
        separateAudioBackpressureDrops += 1
        debugPrint(
          "⚠️ separateAudioInput backpressure drop (hits: \(separateAudioBackpressureHits), drops: \(separateAudioBackpressureDrops))"
        )
        return false
      }
    }
    let appended = separateAudioInput.append(sampleBuffer)
    if appended {
      totalSeparateAudioSamples += 1
      updatePtsRange(pts, min: &separateMicPtsMin, max: &separateMicPtsMax)
      if CMTimeCompare(endTime, lastMicEndTime) > 0 {
        lastMicEndTime = endTime
      }
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
      appAudioDroppedBeforeSession += 1
      debugPrint(
        "⚠️ App audio before video session start; dropping. (count: \(appAudioDroppedBeforeSession))"
      )
      return false
    }

    // Start session if needed
    startAppAudioSessionIfNeeded()

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    // Track first app audio PTS and monotonicity
    if firstAppAudioPTS == nil {
      firstAppAudioPTS = pts
      let deltaToVideo = firstVideoPTS != nil ? CMTimeSubtract(pts, firstVideoPTS!).seconds : 0
      debugPrint("📊 First app audio PTS: \(pts.seconds)s (delta to video: \(deltaToVideo)s)")
    }
    if let prevPTS = lastAppAudioPTS, CMTimeCompare(pts, prevPTS) < 0 {
      appAudioMonotonicityViolations += 1
      debugPrint(
        "⚠️ App audio PTS monotonicity violation: \(pts.seconds)s < \(prevPTS.seconds)s (count: \(appAudioMonotonicityViolations))"
      )
    }
    lastAppAudioPTS = pts

    // Allow small tolerance (100ms) for audio slightly before session start
    let tolerance = CMTime(value: 1, timescale: 10)
    let adjustedStartTime = CMTimeSubtract(startTime, tolerance)
    if CMTimeCompare(pts, adjustedStartTime) < 0 {
      appAudioDroppedPTSBelowStart += 1
      debugPrint(
        "⚠️ App audio timestamp \(pts.seconds)s precedes adjusted start \(adjustedStartTime.seconds)s; dropping. (count: \(appAudioDroppedPTSBelowStart))"
      )
      return false
    }

    // Track format for padding
    if appAudioFormatDescription == nil {
      appAudioFormatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    }
    let duration = audioSampleDuration(sampleBuffer, formatDescription: appAudioFormatDescription)
    let endTime = isPositiveTime(duration) ? CMTimeAdd(pts, duration) : pts

    if !appAudioInput.isReadyForMoreMediaData {
      appAudioBackpressureHits += 1
      // Brief wait for app audio
      if !waitForInputReady(appAudioInput, timeout: audioBackpressureTimeout) {
        appAudioBackpressureDrops += 1
        debugPrint(
          "⚠️ appAudioInput backpressure drop (hits: \(appAudioBackpressureHits), drops: \(appAudioBackpressureDrops))"
        )
        return false
      }
    }
    let appended = appAudioInput.append(sampleBuffer)
    if appended {
      totalAppAudioSamples += 1
      updatePtsRange(pts, min: &appAudioPtsMin, max: &appAudioPtsMax)
      if CMTimeCompare(endTime, lastAppAudioEndTime) > 0 {
        lastAppAudioEndTime = endTime
      }
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

  fileprivate func updatePtsRange(
    _ pts: CMTime,
    min: inout CMTime?,
    max: inout CMTime?
  ) {
    guard pts.isValid, !pts.isIndefinite else { return }
    if let currentMin = min {
      if CMTimeCompare(pts, currentMin) < 0 {
        min = pts
      }
    } else {
      min = pts
    }
    if let currentMax = max {
      if CMTimeCompare(pts, currentMax) > 0 {
        max = pts
      }
    } else {
      max = pts
    }
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

  #if os(iOS)
    fileprivate func audioRouteSignature(_ route: AVAudioSessionRouteDescription) -> String {
      let inputs = route.inputs.map {
        "\($0.portType.rawValue):\($0.portName)"
      }.joined(separator: ",")
      let outputs = route.outputs.map {
        "\($0.portType.rawValue):\($0.portName)"
      }.joined(separator: ",")
      return "in[\(inputs)]|out[\(outputs)]"
    }

    fileprivate func refreshAudioSessionStateIfNeeded() {
      let now = Date()
      if now.timeIntervalSince(lastAudioSessionCheckTime) < audioSessionCheckInterval {
        return
      }
      lastAudioSessionCheckTime = now

      let session = AVAudioSession.sharedInstance()
      let routeSignature = audioRouteSignature(session.currentRoute)
      let sampleRate = session.sampleRate
      let ioBufferDuration = session.ioBufferDuration

      if lastAudioRouteSignature == nil {
        lastAudioRouteSignature = routeSignature
        lastAudioSampleRate = sampleRate
        lastAudioIOBufferDuration = ioBufferDuration
        return
      }

      let routeChanged = routeSignature != lastAudioRouteSignature
      let sampleRateChanged = abs(sampleRate - lastAudioSampleRate) > 1
      let ioBufferChanged = abs(ioBufferDuration - lastAudioIOBufferDuration) > 0.001

      if routeChanged || sampleRateChanged || ioBufferChanged {
        audioSessionChangeCount += 1
        lastAudioRouteSignature = routeSignature
        lastAudioSampleRate = sampleRate
        lastAudioIOBufferDuration = ioBufferDuration

        micTimingOffsetResolved = false
        appAudioTimingOffsetResolved = false
        micTimingOffset = .zero
        appAudioTimingOffset = .zero
        observedFirstMicDeltaToVideo = nil
        observedFirstAppAudioDeltaToVideo = nil

        debugPrint(
          "🔄 Audio session changed; resetting timing offsets (route=\(routeSignature), rate=\(String(format: "%.0f", sampleRate)))"
        )
      }
    }
  #endif

  fileprivate func resolveTimingOffsetIfNeeded(
    currentPTS: CMTime,
    firstVideoPTS: CMTime,
    resolved: inout Bool,
    offset: inout CMTime,
    observedDelta: inout Double?,
    label: String
  ) {
    if observedDelta == nil {
      observedDelta = CMTimeSubtract(currentPTS, firstVideoPTS).seconds
    }

    guard !resolved else { return }

    let delta = CMTimeSubtract(currentPTS, firstVideoPTS)
    if delta.isValid, !delta.isIndefinite {
      let deltaSeconds = delta.seconds
      let absDeltaSeconds = abs(deltaSeconds)
      let thresholdSeconds = timingOffsetThreshold.seconds
      let maxSeconds = timingOffsetMax.seconds

      if absDeltaSeconds > thresholdSeconds {
        if absDeltaSeconds >= maxSeconds {
          debugPrint(
            "⏱️ Skipping \(label) timing offset: \(String(format: "%.3f", deltaSeconds))s exceeds max \(String(format: "%.3f", maxSeconds))s"
          )
        } else {
          offset = delta
          debugPrint(
            "⏱️ Applying \(label) timing offset: \(String(format: "%.3f", deltaSeconds))s"
          )
        }
      }
    }
    resolved = true
  }

  fileprivate func adjustedAudioSampleBufferIfNeeded(
    _ sampleBuffer: CMSampleBuffer,
    audioType: RPSampleBufferType
  ) -> CMSampleBuffer {
    #if os(iOS)
      refreshAudioSessionStateIfNeeded()
    #endif
    guard audioType == .audioMic || audioType == .audioApp else {
      return sampleBuffer
    }
    guard let firstVideo = firstVideoPTS else {
      return sampleBuffer
    }

    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    switch audioType {
    case .audioMic:
      resolveTimingOffsetIfNeeded(
        currentPTS: pts,
        firstVideoPTS: firstVideo,
        resolved: &micTimingOffsetResolved,
        offset: &micTimingOffset,
        observedDelta: &observedFirstMicDeltaToVideo,
        label: "mic"
      )
      guard micTimingOffsetResolved else { return sampleBuffer }
      let baseOffset = CMTimeMultiply(micTimingOffset, multiplier: -1)
      let applyLeadCompensation = micTimingOffset.seconds < 0
      let offset =
        applyLeadCompensation
        ? CMTimeAdd(baseOffset, audioLeadCompensation)
        : baseOffset
      guard CMTimeCompare(offset, .zero) != 0 else { return sampleBuffer }
      if let adjusted = sampleBufferByApplyingTimeOffset(
        sampleBuffer,
        offset: offset,
        minPTS: sessionStartTime
      ) {
        micAdjustmentAppliedCount += 1
        micAdjustmentAppliedSeconds = offset.seconds
        return adjusted
      }
      return sampleBuffer
    case .audioApp:
      resolveTimingOffsetIfNeeded(
        currentPTS: pts,
        firstVideoPTS: firstVideo,
        resolved: &appAudioTimingOffsetResolved,
        offset: &appAudioTimingOffset,
        observedDelta: &observedFirstAppAudioDeltaToVideo,
        label: "app audio"
      )
      guard appAudioTimingOffsetResolved else { return sampleBuffer }
      let baseOffset = CMTimeMultiply(appAudioTimingOffset, multiplier: -1)
      let applyLeadCompensation = appAudioTimingOffset.seconds < 0
      let offset =
        applyLeadCompensation
        ? CMTimeAdd(baseOffset, audioLeadCompensation)
        : baseOffset
      guard CMTimeCompare(offset, .zero) != 0 else { return sampleBuffer }
      if let adjusted = sampleBufferByApplyingTimeOffset(
        sampleBuffer,
        offset: offset,
        minPTS: sessionStartTime
      ) {
        appAudioAdjustmentAppliedCount += 1
        appAudioAdjustmentAppliedSeconds = offset.seconds
        return adjusted
      }
      return sampleBuffer
    default:
      return sampleBuffer
    }
  }

  fileprivate func sampleBufferByApplyingTimeOffset(
    _ sampleBuffer: CMSampleBuffer,
    offset: CMTime,
    minPTS: CMTime?
  ) -> CMSampleBuffer? {
    let entryCount = CMSampleBufferGetNumSamples(sampleBuffer)
    guard entryCount > 0 else {
      return nil
    }

    var timingInfo = Array(
      repeating: CMSampleTimingInfo(
        duration: .invalid,
        presentationTimeStamp: .invalid,
        decodeTimeStamp: .invalid
      ),
      count: entryCount
    )

    var timingInfoCount: CMItemCount = 0
    let status = CMSampleBufferGetSampleTimingInfoArray(
      sampleBuffer,
      entryCount: entryCount,
      arrayToFill: &timingInfo,
      entriesNeededOut: &timingInfoCount
    )
    guard status == noErr, timingInfoCount > 0 else {
      return nil
    }

    let count = Int(timingInfoCount)
    for index in 0..<count {
      let originalPTS = timingInfo[index].presentationTimeStamp
      if originalPTS.isValid, !originalPTS.isIndefinite {
        var adjustedPTS = CMTimeAdd(originalPTS, offset)
        if let minPTS, CMTimeCompare(adjustedPTS, minPTS) < 0 {
          adjustedPTS = minPTS
        }
        timingInfo[index].presentationTimeStamp = adjustedPTS
      }

      let originalDTS = timingInfo[index].decodeTimeStamp
      if originalDTS.isValid, !originalDTS.isIndefinite {
        var adjustedDTS = CMTimeAdd(originalDTS, offset)
        if let minPTS, CMTimeCompare(adjustedDTS, minPTS) < 0 {
          adjustedDTS = minPTS
        }
        timingInfo[index].decodeTimeStamp = adjustedDTS
      }
    }

    var adjustedBuffer: CMSampleBuffer?
    let copyStatus = CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sampleBuffer,
      sampleTimingEntryCount: count,
      sampleTimingArray: &timingInfo,
      sampleBufferOut: &adjustedBuffer
    )
    guard copyStatus == noErr else {
      return nil
    }
    return adjustedBuffer
  }

  fileprivate func waitForInputReady(_ input: AVAssetWriterInput, timeout: TimeInterval) -> Bool {
    let start = Date()
    while !input.isReadyForMoreMediaData {
      if Date().timeIntervalSince(start) >= timeout {
        return false
      }
      Thread.sleep(forTimeInterval: inputReadyPollInterval)
    }
    return true
  }
}
