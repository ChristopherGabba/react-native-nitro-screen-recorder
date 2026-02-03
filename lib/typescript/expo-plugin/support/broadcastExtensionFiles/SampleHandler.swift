import AVFoundation
import Darwin
import ReplayKit
import UserNotifications

@_silgen_name("finishBroadcastGracefully")
func finishBroadcastGracefully(_ handler: RPBroadcastSampleHandler)

/*
 Handles the main processing of the global broadcast.
 The app-group identifier is fetched from the extension's Info.plist
 ("BroadcastExtensionAppGroupIdentifier" key) so you don't have to hard-code it here.
 */
final class SampleHandler: RPBroadcastSampleHandler {

  // MARK: – Properties

  private func appGroupIDFromPlist() -> String? {
    guard
      let value = Bundle.main.object(forInfoDictionaryKey: "BroadcastExtensionAppGroupIdentifier")
        as? String,
      !value.isEmpty
    else {
      return nil
    }
    return value
  }

  // MARK: - Extension Logging

  /// Maximum number of log entries to keep (ring buffer)
  private static let maxLogEntries = 200

  /// Logs a message to shared UserDefaults for debugging from the main app
  private func extensionLog(_ message: String, level: String = "INFO") {
    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else {
      debugPrint("[ExtLog] \(message)")  // Fallback to debugPrint
      return
    }

    let timestamp = Date().timeIntervalSince1970
    let dateFormatter = ISO8601DateFormatter()
    dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timeString = dateFormatter.string(from: Date())

    let entry: [String: Any] = [
      "timestamp": timestamp,
      "time": timeString,
      "level": level,
      "message": message,
    ]

    var logs = defaults.array(forKey: "ExtensionLogs") as? [[String: Any]] ?? []
    logs.append(entry)

    // Keep only the last N entries (ring buffer)
    if logs.count > SampleHandler.maxLogEntries {
      logs = Array(logs.suffix(SampleHandler.maxLogEntries))
    }

    defaults.set(logs, forKey: "ExtensionLogs")
    defaults.synchronize()

    // Also print for Xcode console when debugging
    debugPrint("[\(level)] \(message)")
  }

  /// Convenience methods for different log levels
  private func logInfo(_ message: String) { extensionLog(message, level: "INFO") }
  private func logWarning(_ message: String) { extensionLog(message, level: "WARN") }
  private func logError(_ message: String) { extensionLog(message, level: "ERROR") }
  private func logDebug(_ message: String) { extensionLog(message, level: "DEBUG") }

  /// Logs audio metrics as a structured entry for Sentry integration
  private func logAudioMetrics(_ metrics: [String: Any], context: String) {
    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else {
      return
    }

    let timestamp = Date().timeIntervalSince1970
    let dateFormatter = ISO8601DateFormatter()
    dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let timeString = dateFormatter.string(from: Date())

    var entry: [String: Any] = [
      "timestamp": timestamp,
      "time": timeString,
      "context": context,
      "type": "audioMetrics",
    ]

    // Merge metrics into entry
    for (key, value) in metrics {
      entry[key] = value
    }

    // Store in a separate key for easy retrieval
    var metricsLog = defaults.array(forKey: "ExtensionAudioMetrics") as? [[String: Any]] ?? []
    metricsLog.append(entry)

    // Keep only last 50 metrics entries
    if metricsLog.count > 50 {
      metricsLog = Array(metricsLog.suffix(50))
    }

    defaults.set(metricsLog, forKey: "ExtensionAudioMetrics")
    defaults.synchronize()

    // Also log key metrics to main log
    let summary =
      "📊 AudioMetrics[\(context)]: " + "video=\(metrics["totalVideoFrames"] ?? 0) frames, "
      + "mic=\(metrics["totalMicSamples"] ?? 0) samples, "
      + "videoDur=\(String(format: "%.2f", (metrics["videoDuration"] as? Double) ?? 0))s, "
      + "micDur=\(String(format: "%.2f", (metrics["micDuration"] as? Double) ?? 0))s, "
      + "backpressureDrops=\(metrics["micBackpressureDrops"] ?? 0)mic/\(metrics["separateAudioBackpressureDrops"] ?? 0)sep"
    logInfo(summary)
  }

  // Store both the CFString and CFNotificationName versions for all notifications
  private static let stopNotificationString = "com.nitroscreenrecorder.stopBroadcast" as CFString
  private static let stopNotificationName = CFNotificationName(stopNotificationString)

  private static let markChunkNotificationString = "com.nitroscreenrecorder.markChunk" as CFString
  private static let markChunkNotificationName = CFNotificationName(markChunkNotificationString)

  private static let finalizeChunkNotificationString =
    "com.nitroscreenrecorder.finalizeChunk" as CFString
  private static let finalizeChunkNotificationName = CFNotificationName(
    finalizeChunkNotificationString)

  private lazy var hostAppGroupIdentifier: String? = {
    return appGroupIDFromPlist()
  }()

  private var writer: BroadcastWriter?
  private let fileManager: FileManager = .default

  // These are now var because they get replaced when swapping writers
  private var nodeURL: URL
  private var audioNodeURL: URL  // Mic audio
  private var appAudioNodeURL: URL  // App/system audio
  private var sawMicBuffers = false
  private var separateAudioFile: Bool = false
  private var isBroadcastActive = false
  private var isCapturing = false
  private var chunkStartedAt: Double = 0

  // Serial queue for thread-safe writer operations
  private let writerQueue = DispatchQueue(label: "com.nitroscreenrecorder.writerQueue")

  // Status update tracking - update every N frames to avoid excessive writes
  private var frameCount: Int = 0
  private let statusUpdateInterval: Int = 15  // Update every 15 frames (~0.25 sec at 60fps)

  // Chunk ID for queue-based retrieval (captured at markChunk, used at save)
  private var pendingChunkId: String?

  // Token-based deduplication for markChunk (tracks last processed token)
  private var lastMarkChunkToken: String? = nil

  // MARK: – Init
  override init() {
    let uuid = UUID().uuidString
    nodeURL = fileManager.temporaryDirectory
      .appendingPathComponent(uuid)
      .appendingPathExtension(for: .mpeg4Movie)

    audioNodeURL = fileManager.temporaryDirectory
      .appendingPathComponent("\(uuid)_mic_audio")
      .appendingPathExtension("m4a")

    appAudioNodeURL = fileManager.temporaryDirectory
      .appendingPathComponent("\(uuid)_app_audio")
      .appendingPathExtension("m4a")

    fileManager.removeFileIfExists(url: nodeURL)
    fileManager.removeFileIfExists(url: audioNodeURL)
    fileManager.removeFileIfExists(url: appAudioNodeURL)
    super.init()
  }

  deinit {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

    CFNotificationCenterRemoveObserver(center, observer, SampleHandler.stopNotificationName, nil)
    CFNotificationCenterRemoveObserver(
      center, observer, SampleHandler.markChunkNotificationName, nil)
    CFNotificationCenterRemoveObserver(
      center, observer, SampleHandler.finalizeChunkNotificationName, nil)
  }

  private func startListeningForNotifications() {
    let center = CFNotificationCenterGetDarwinNotifyCenter()
    let observer = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

    // Listen for stop broadcast signal
    CFNotificationCenterAddObserver(
      center,
      observer,
      { _, observer, name, _, _ in
        guard let observer, let name, name == SampleHandler.stopNotificationName else { return }
        let me = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
        me.stopBroadcastGracefully()
      },
      SampleHandler.stopNotificationString,
      nil,
      .deliverImmediately
    )

    // Listen for mark chunk signal (discard current, start fresh)
    CFNotificationCenterAddObserver(
      center,
      observer,
      { _, observer, name, _, _ in
        guard let observer, let name, name == SampleHandler.markChunkNotificationName else {
          return
        }
        let me = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
        me.handleMarkChunk()
      },
      SampleHandler.markChunkNotificationString,
      nil,
      .deliverImmediately
    )

    // Listen for finalize chunk signal (save current, start fresh)
    CFNotificationCenterAddObserver(
      center,
      observer,
      { _, observer, name, _, _ in
        guard let observer, let name, name == SampleHandler.finalizeChunkNotificationName else {
          return
        }
        let me = Unmanaged<SampleHandler>.fromOpaque(observer).takeUnretainedValue()
        me.handleFinalizeChunk()
      },
      SampleHandler.finalizeChunkNotificationString,
      nil,
      .deliverImmediately
    )
  }

  // MARK: – Broadcast lifecycle
  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    startListeningForNotifications()

    // Mark broadcast as active
    isBroadcastActive = true
    updateExtensionStatus()

    // Reset mark token tracking for fresh session
    lastMarkChunkToken = nil

    logInfo("broadcastStarted: Broadcast session starting...")

    // Configure audio session for Bluetooth support (AirPods, etc.)
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(
        .playAndRecord,
        mode: .videoRecording,
        options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
      )
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
      logInfo("broadcastStarted: Audio session configured with Bluetooth support")
    } catch {
      logWarning(
        "broadcastStarted: Failed to configure audio session: \(error.localizedDescription)")
    }

    guard let groupID = hostAppGroupIdentifier else {
      logError("broadcastStarted: Missing app group identifier")
      finishBroadcastWithError(
        NSError(
          domain: "SampleHandler",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Missing app group identifier"]
        )
      )
      return
    }

    // Check if separate audio file is requested
    if let userDefaults = UserDefaults(suiteName: groupID) {
      separateAudioFile = userDefaults.bool(forKey: "SeparateAudioFileEnabled")
    }

    logInfo("broadcastStarted: separateAudioFile=\(separateAudioFile), appGroup=\(groupID)")

    // Clean up old recordings
    cleanupOldRecordings(in: groupID)

    // Start recording
    let screen: UIScreen = .main
    do {
      writer = try .init(
        outputURL: nodeURL,
        audioOutputURL: separateAudioFile ? audioNodeURL : nil,
        appAudioOutputURL: separateAudioFile ? appAudioNodeURL : nil,
        screenSize: screen.bounds.size,
        screenScale: screen.scale,
        separateAudioFile: separateAudioFile
      )
      try writer?.start()
      logInfo("broadcastStarted: Writer started successfully, output=\(nodeURL.lastPathComponent)")
    } catch {
      logError("broadcastStarted: Failed to create/start writer: \(error.localizedDescription)")
      finishBroadcastWithError(error)
    }
  }

  private func cleanupOldRecordings(in groupID: String) {
    guard
      let docs = fileManager.containerURL(
        forSecurityApplicationGroupIdentifier: groupID)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else { return }

    do {
      let items = try fileManager.contentsOfDirectory(at: docs, includingPropertiesForKeys: nil)
      for url in items {
        let ext = url.pathExtension.lowercased()
        // Clean up video and audio files from previous recordings
        if ext == "mp4" || ext == "m4a" {
          try? fileManager.removeItem(at: url)
        }
      }
    } catch {
      // Non-critical error, continue with broadcast
    }

    // Also clear the stale pending chunks queue and mark tokens from previous sessions
    if let defaults = UserDefaults(suiteName: groupID) {
      defaults.removeObject(forKey: "PendingChunks")
      defaults.removeObject(forKey: "CurrentChunkId")
      defaults.removeObject(forKey: "MarkChunkToken")
      defaults.removeObject(forKey: "LastProcessedMarkToken")
      defaults.synchronize()
      debugPrint("✅ Cleared stale PendingChunks queue and mark tokens")
    }
  }

  // Track frames per writer for debugging
  private var videoFramesThisWriter: Int = 0
  private var lastVideoFrameTime: Date?
  private var totalVideoFrames: Int = 0

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    // Use sync to ensure thread safety with writer swaps
    writerQueue.sync {
      guard let writer = self.writer else {
        // Log if we're dropping frames because writer is nil
        if sampleBufferType == .video {
          self.logWarning("processSampleBuffer: VIDEO frame dropped - writer is nil!")
        }
        return
      }

      if sampleBufferType == .audioMic {
        self.sawMicBuffers = true
      }

      // Track and log video frames for debugging
      if sampleBufferType == .video {
        self.totalVideoFrames += 1
        self.videoFramesThisWriter += 1
        self.frameCount += 1

        // Check for gap in frame delivery
        let now = Date()
        if let lastTime = self.lastVideoFrameTime {
          let gap = now.timeIntervalSince(lastTime)
          if gap > 0.5 {  // Log if gap > 500ms
            self.logWarning(
              "processSampleBuffer: VIDEO RESUMED after \(Int(gap * 1000))ms gap (total frames: \(self.totalVideoFrames))"
            )
          }
        }
        self.lastVideoFrameTime = now

        // Log first frame for this writer
        if self.videoFramesThisWriter == 1 {
          self.logInfo(
            "processSampleBuffer: FIRST VIDEO FRAME for writer #\(self.totalVideoFrames) total")
        }

        if self.frameCount >= self.statusUpdateInterval {
          self.frameCount = 0
          self.updateExtensionStatus()
        }
      }

      do {
        let success = try writer.processSampleBuffer(sampleBuffer, with: sampleBufferType)
        if sampleBufferType == .video && !success && self.videoFramesThisWriter <= 3 {
          self.logWarning(
            "processSampleBuffer: Video frame \(self.videoFramesThisWriter) NOT appended")
        }
      } catch {
        self.logError("processSampleBuffer: Error - \(error.localizedDescription)")
        self.finishBroadcastWithError(error)
      }
    }
  }

  /// Updates the extension status in UserDefaults for the main app to read
  private func updateExtensionStatus() {
    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else { return }

    defaults.set(sawMicBuffers, forKey: "ExtensionMicActive")
    defaults.set(isCapturing, forKey: "ExtensionCapturing")
    defaults.set(chunkStartedAt, forKey: "ExtensionChunkStartedAt")
    defaults.synchronize()  // Force sync for cross-process visibility
  }

  override func broadcastPaused() {
    writer?.pause()
  }

  override func broadcastResumed() {
    writer?.resume()
  }

  private func stopBroadcastGracefully() {
    finishBroadcastGracefully(self)
  }

  // MARK: – Chunk Management

  /**
   Handles markChunkStart: Discards the current recording and starts a fresh one.
   The current file is NOT saved to the shared container.
   Captures the chunkId from UserDefaults at the START of this chunk.
   */
  // Debounce tracking for duplicate notification protection
  // We track ARRIVAL time (before sync) to properly debounce even when lock contention delays processing
  private var lastMarkChunkArrivalTime: TimeInterval = 0
  private var lastFinalizeChunkArrivalTime: TimeInterval = 0
  private let debounceThreshold: TimeInterval = 0.15  // 150ms debounce (accounts for 50ms notification delay + margin)

  private func handleMarkChunk() {
    // Capture arrival time BEFORE entering sync to properly debounce duplicate notifications
    let arrivalTime = Date().timeIntervalSince1970
    let markStartTime = Date()

    writerQueue.sync {
      // TOKEN-BASED DEDUPE: Check token first - this is the primary deduplication mechanism
      if let groupID = hostAppGroupIdentifier,
         let token = UserDefaults(suiteName: groupID)?.string(forKey: "MarkChunkToken")
      {
        if token == self.lastMarkChunkToken {
          self.logDebug("handleMarkChunk: Ignoring duplicate token \(token)")
          return  // Skip duplicate - already processed this token
        }
        self.lastMarkChunkToken = token
        self.logDebug("handleMarkChunk: Processing token \(token)")
      }

      // Secondary protection: time-based debounce (fallback if token check fails)
      if arrivalTime - self.lastMarkChunkArrivalTime < self.debounceThreshold {
        self.logDebug(
          "handleMarkChunk: Ignoring (debounce, delta=\(Int((arrivalTime - self.lastMarkChunkArrivalTime) * 1000))ms)"
        )
        return
      }
      self.lastMarkChunkArrivalTime = arrivalTime

      self.logInfo(
        "handleMarkChunk: Processing... (lock wait: \(Int(Date().timeIntervalSince(markStartTime) * 1000))ms, writerFrames: \(self.videoFramesThisWriter), totalFrames: \(self.totalVideoFrames))"
      )
      self.isCapturing = true
      self.chunkStartedAt = Date().timeIntervalSince1970

      // Capture chunkId at the START of this chunk (before it could be overwritten)
      if let groupID = hostAppGroupIdentifier {
        self.pendingChunkId = UserDefaults(suiteName: groupID)?.string(forKey: "CurrentChunkId")
        self.logInfo("handleMarkChunk: Captured chunkId=\(self.pendingChunkId ?? "nil")")
      }

      // Finish current writer without saving
      if let currentWriter = self.writer {
        // Check if any frames were received
        if !currentWriter.hasReceivedVideoFrames {
          self.logDebug("handleMarkChunk: Previous writer had no frames, canceling")
        } else {
          self.logDebug("handleMarkChunk: Discarding writer with frames")
        }

        do {
          _ = try currentWriter.finishWithAudio()
          self.logInfo("handleMarkChunk: Previous writer finished (discarded)")
        } catch {
          // Expected if no frames - writer was cancelled
          self.logDebug("handleMarkChunk: Previous writer cancelled/failed (expected if empty)")
        }
      }

      // Delete the temp files (don't save them)
      self.fileManager.removeFileIfExists(url: self.nodeURL)
      self.fileManager.removeFileIfExists(url: self.audioNodeURL)
      self.fileManager.removeFileIfExists(url: self.appAudioNodeURL)

      // Create new writer with fresh file URLs
      self.createNewWriter()
      
      // WRITE ACK TOKEN - Main app polls for this to confirm processing
      if let groupID = hostAppGroupIdentifier,
         let token = UserDefaults(suiteName: groupID)?.string(forKey: "MarkChunkToken") {
        UserDefaults(suiteName: groupID)?.set(token, forKey: "LastProcessedMarkToken")
        UserDefaults(suiteName: groupID)?.synchronize()
        self.logDebug("handleMarkChunk: Wrote ack token \(token)")
      }

      let totalTime = Int(Date().timeIntervalSince(markStartTime) * 1000)
      self.logInfo("handleMarkChunk: Complete (total lock time: \(totalTime)ms)")
    }
  }

  /**
   Handles finalizeChunk: Saves the current recording to the shared container and starts a fresh one.
   The saved file can be retrieved by the main app.
   */
  private func handleFinalizeChunk() {
    // Capture arrival time BEFORE entering sync to properly debounce duplicate notifications
    let arrivalTime = Date().timeIntervalSince1970
    let finalizeStartTime = Date()

    writerQueue.sync {
      // Debounce: ignore if this notification arrived within threshold of the last one
      if arrivalTime - self.lastFinalizeChunkArrivalTime < self.debounceThreshold {
        self.logDebug(
          "handleFinalizeChunk: Ignoring duplicate notification (debounce, delta=\(Int((arrivalTime - self.lastFinalizeChunkArrivalTime) * 1000))ms)"
        )
        // Still send notification so main app doesn't hang on the duplicate call
        let notif = "com.nitroscreenrecorder.chunkSaved" as CFString
        CFNotificationCenterPostNotification(
          CFNotificationCenterGetDarwinNotifyCenter(),
          CFNotificationName(notif),
          nil,
          nil,
          true
        )
        return
      }
      self.lastFinalizeChunkArrivalTime = arrivalTime

      self.logInfo(
        "handleFinalizeChunk: Saving current chunk, chunkId=\(self.pendingChunkId ?? "nil"), frames=\(self.videoFramesThisWriter)"
      )

      // Mark capturing as done (will restart with next markChunkStart)
      self.isCapturing = false
      self.chunkStartedAt = 0

      // Helper to send notification (call before any early return)
      func sendChunkNotification() {
        let notif = "com.nitroscreenrecorder.chunkSaved" as CFString
        CFNotificationCenterPostNotification(
          CFNotificationCenterGetDarwinNotifyCenter(),
          CFNotificationName(notif),
          nil,
          nil,
          true
        )
        self.logInfo("handleFinalizeChunk: Sent chunkSaved notification")
      }

      guard let currentWriter = self.writer else {
        self.logWarning("handleFinalizeChunk: No active writer - creating new one")
        self.createNewWriter()
        sendChunkNotification()  // Notify so main app doesn't hang
        return
      }

      // Log detailed writer state before finishing
      let diagnostics = currentWriter.getDiagnostics()
      self.logInfo("handleFinalizeChunk: Writer state before finish: \(diagnostics)")

      // Check if writer has received any video frames
      if !currentWriter.hasReceivedVideoFrames {
        self.logWarning(
          "handleFinalizeChunk: NO VIDEO FRAMES received (count=\(self.videoFramesThisWriter)) - chunk is empty, skipping save"
        )
        // Release the writer (it will be cancelled internally)
        do {
          _ = try currentWriter.finishWithAudio()
        } catch {
          // Expected to fail/cancel - that's fine
        }
        self.writer = nil
        self.createNewWriter()
        sendChunkNotification()
        return
      }

      // Finish current writer and get the result
      let result: BroadcastWriter.FinishResult
      do {
        result = try currentWriter.finishWithAudio()
        self.logInfo(
          "handleFinalizeChunk: Writer finished successfully, video=\(result.videoURL.lastPathComponent)"
        )
      } catch let writerError as NSError {
        // Log detailed error info
        self.logError(
          "handleFinalizeChunk: FAILED - domain=\(writerError.domain), code=\(writerError.code)")
        self.logError("handleFinalizeChunk: FAILED - \(writerError.localizedDescription)")
        if let underlyingError = writerError.userInfo[NSUnderlyingErrorKey] as? NSError {
          self.logError(
            "handleFinalizeChunk: Underlying error - \(underlyingError.localizedDescription)")
        }
        // Log writer state after failure
        let postDiagnostics = currentWriter.getDiagnostics()
        self.logError("handleFinalizeChunk: Writer state after failure: \(postDiagnostics)")

        // Release the failed writer explicitly
        self.writer = nil
        // Still try to create a new writer so recording can continue
        self.createNewWriter()
        sendChunkNotification()  // Notify so main app doesn't hang
        return
      } catch {
        self.logError("handleFinalizeChunk: Error finishing writer: \(error.localizedDescription)")
        // Release the failed writer explicitly
        self.writer = nil
        // Still try to create a new writer so recording can continue
        self.createNewWriter()
        sendChunkNotification()  // Notify so main app doesn't hang
        return
      }

      // Release the finished writer before creating new one
      self.writer = nil

      // Log audio metrics after finishing so they match the saved file
      var audioMetrics = currentWriter.getAudioMetrics()
      audioMetrics["outputVideoFile"] = result.videoURL.lastPathComponent
      if let audioURL = result.audioURL {
        audioMetrics["outputAudioFile"] = audioURL.lastPathComponent
      }
      if let appAudioURL = result.appAudioURL {
        audioMetrics["outputAppAudioFile"] = appAudioURL.lastPathComponent
      }
      if let chunkId = self.pendingChunkId {
        audioMetrics["chunkId"] = chunkId
      }
      self.logAudioMetrics(audioMetrics, context: "handleFinalizeChunk")

      // Save the chunk to shared container
      self.saveChunkToContainer(result: result)

      // Create new writer with fresh file URLs
      self.createNewWriter()
      let totalTime = Int(Date().timeIntervalSince(finalizeStartTime) * 1000)
      self.logInfo("handleFinalizeChunk: New chunk started (total lock time: \(totalTime)ms)")
    }
  }

  /**
   Creates a new BroadcastWriter with fresh file URLs.
   Must be called from within writerQueue.
   */
  private func createNewWriter() {
    // Explicitly release old writer reference first
    writer = nil

    let screen: UIScreen = .main
    var attempts = 0
    let maxAttempts = 3

    // Reset per-writer frame counter
    videoFramesThisWriter = 0
    logDebug("createNewWriter: Starting, screen size=\(screen.bounds.size), scale=\(screen.scale)")

    while attempts < maxAttempts {
      attempts += 1

      // Generate fresh UUID for each attempt
      let uuid = UUID().uuidString

      // Generate new file URLs
      nodeURL = fileManager.temporaryDirectory
        .appendingPathComponent(uuid)
        .appendingPathExtension(for: .mpeg4Movie)

      audioNodeURL = fileManager.temporaryDirectory
        .appendingPathComponent("\(uuid)_mic_audio")
        .appendingPathExtension("m4a")

      appAudioNodeURL = fileManager.temporaryDirectory
        .appendingPathComponent("\(uuid)_app_audio")
        .appendingPathExtension("m4a")

      // Aggressively clean up any existing files at these paths
      fileManager.removeFileIfExists(url: nodeURL)
      fileManager.removeFileIfExists(url: audioNodeURL)
      fileManager.removeFileIfExists(url: appAudioNodeURL)

      do {
        writer = try BroadcastWriter(
          outputURL: nodeURL,
          audioOutputURL: separateAudioFile ? audioNodeURL : nil,
          appAudioOutputURL: separateAudioFile ? appAudioNodeURL : nil,
          screenSize: screen.bounds.size,
          screenScale: screen.scale,
          separateAudioFile: separateAudioFile
        )
        try writer?.start()
        logInfo(
          "createNewWriter: New writer created and started (attempt \(attempts)), output=\(nodeURL.lastPathComponent)"
        )
        return  // Success, exit
      } catch {
        logError(
          "createNewWriter: Attempt \(attempts)/\(maxAttempts) failed: \(error.localizedDescription)"
        )
        writer = nil

        if attempts < maxAttempts {
          // Brief delay before retry to let resources release
          Thread.sleep(forTimeInterval: 0.05)  // 50ms (reduced from 150ms)
        }
      }
    }

    logError("createNewWriter: All \(maxAttempts) attempts failed - writer is nil")
  }

  /**
   Saves a finished chunk to the shared App Group container using queue-based storage.
   Must be called from within writerQueue.
   Uses the captured pendingChunkId for correct pairing with video/audio files.
   */
  private func saveChunkToContainer(result: BroadcastWriter.FinishResult) {
    // Helper to send notification (always call before returning)
    func sendChunkNotification() {
      let notif = "com.nitroscreenrecorder.chunkSaved" as CFString
      CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotifyCenter(),
        CFNotificationName(notif),
        nil,
        nil,
        true
      )
      self.logInfo("saveChunkToContainer: Sent chunkSaved notification")
    }

    // Log video file info
    let videoExists = fileManager.fileExists(atPath: result.videoURL.path)
    var videoSize: Int64 = 0
    if let attrs = try? fileManager.attributesOfItem(atPath: result.videoURL.path) {
      videoSize = (attrs[.size] as? Int64) ?? 0
    }
    self.logInfo(
      "saveChunkToContainer: Video file exists=\(videoExists), size=\(videoSize) bytes, path=\(result.videoURL.lastPathComponent)"
    )

    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else {
      self.logError("saveChunkToContainer: No app group identifier")
      sendChunkNotification()  // Still notify so main app doesn't hang
      return
    }

    guard
      let containerURL =
        fileManager
        .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else {
      self.logError("saveChunkToContainer: Could not get container URL")
      sendChunkNotification()
      return
    }

    // Create directory if needed
    do {
      try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
    } catch {
      self.logError(
        "saveChunkToContainer: Could not create directory: \(error.localizedDescription)")
      sendChunkNotification()
      return
    }

    // Move video file to shared container
    let videoDestination = containerURL.appendingPathComponent(result.videoURL.lastPathComponent)
    do {
      // Check if destination already exists and remove it
      if fileManager.fileExists(atPath: videoDestination.path) {
        self.logWarning("saveChunkToContainer: Destination file already exists, removing")
        try fileManager.removeItem(at: videoDestination)
      }
      try fileManager.moveItem(at: result.videoURL, to: videoDestination)

      // Verify the move succeeded
      let destExists = fileManager.fileExists(atPath: videoDestination.path)
      var destSize: Int64 = 0
      if let attrs = try? fileManager.attributesOfItem(atPath: videoDestination.path) {
        destSize = (attrs[.size] as? Int64) ?? 0
      }
      self.logInfo(
        "saveChunkToContainer: Video moved to container, exists=\(destExists), size=\(destSize) bytes"
      )
    } catch {
      self.logError("saveChunkToContainer: Failed to move video: \(error.localizedDescription)")
      sendChunkNotification()  // Notify even on failure
      return
    }

    // Move mic audio file if it exists
    var micAudioFileName: String? = nil
    if let audioURL = result.audioURL {
      let audioDestination = containerURL.appendingPathComponent(audioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: audioURL, to: audioDestination)
        micAudioFileName = audioDestination.lastPathComponent
        self.logInfo("saveChunkToContainer: Mic audio saved: \(micAudioFileName!)")
      } catch {
        self.logWarning(
          "saveChunkToContainer: Failed to move mic audio: \(error.localizedDescription)")
      }
    }

    // Move app audio file if it exists
    var appAudioFileName: String? = nil
    if let appAudioURL = result.appAudioURL {
      let appAudioDestination = containerURL.appendingPathComponent(appAudioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: appAudioURL, to: appAudioDestination)
        appAudioFileName = appAudioDestination.lastPathComponent
        self.logInfo("saveChunkToContainer: App audio saved: \(appAudioFileName!)")
      } catch {
        self.logWarning(
          "saveChunkToContainer: Failed to move app audio: \(error.localizedDescription)")
      }
    }

    // Build queue entry with all file references together (atomic pairing)
    var entry: [String: Any] = [
      "video": videoDestination.lastPathComponent,
      "micEnabled": sawMicBuffers,
      "hadSeparateAudio": separateAudioFile,
      "timestamp": Date().timeIntervalSince1970,
    ]

    if let id = pendingChunkId {
      entry["chunkId"] = id
    }
    if let mic = micAudioFileName {
      entry["micAudio"] = mic
    }
    if let app = appAudioFileName {
      entry["appAudio"] = app
    }

    // Add to queue (replace if same chunkId exists to handle retries)
    var chunks = defaults.array(forKey: "PendingChunks") as? [[String: Any]] ?? []

    // Remove existing entry with same chunkId (if any) to handle retries
    if let id = pendingChunkId {
      chunks.removeAll { ($0["chunkId"] as? String) == id }
    }

    chunks.append(entry)
    defaults.set(chunks, forKey: "PendingChunks")
    defaults.synchronize()

    self.logInfo(
      "saveChunkToContainer: Added to queue (total: \(chunks.count)), chunkId=\(pendingChunkId ?? "nil"), video=\(videoDestination.lastPathComponent)"
    )

    // Clear pendingChunkId for next chunk
    pendingChunkId = nil

    // Notify main app that chunk is saved and ready for retrieval
    let notif = "com.nitroscreenrecorder.chunkSaved" as CFString
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(notif),
      nil,
      nil,
      true
    )
    self.logInfo("saveChunkToContainer: Sent chunkSaved notification")
  }

  override func broadcastFinished() {
    logInfo("broadcastFinished: Broadcast ending...")

    guard let writer else {
      logWarning("broadcastFinished: No writer present")
      clearExtensionStatus()
      return
    }

    // Finish writing - use finishWithAudio to get both video and audio URLs
    let result: BroadcastWriter.FinishResult
    do {
      result = try writer.finishWithAudio()
      logInfo("broadcastFinished: Writer finished, video=\(result.videoURL.lastPathComponent)")
    } catch {
      // Writer failed, but we can't call finishBroadcastWithError here
      // as we're already in the finish process
      logError("broadcastFinished: Failed to finish writer: \(error.localizedDescription)")
      clearExtensionStatus()
      return
    }

    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else {
      clearExtensionStatus()
      return
    }

    // Get container directory
    guard
      let containerURL =
        fileManager
        .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else {
      clearExtensionStatus()
      return
    }

    // Create directory if needed
    do {
      try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
    } catch {
      clearExtensionStatus()
      return
    }

    // Move video file to shared container
    let videoDestination = containerURL.appendingPathComponent(result.videoURL.lastPathComponent)
    do {
      try fileManager.moveItem(at: result.videoURL, to: videoDestination)
      debugPrint("✅ broadcastFinished: Video saved to \(videoDestination.lastPathComponent)")
    } catch {
      debugPrint("❌ broadcastFinished: Failed to move video: \(error)")
      clearExtensionStatus()
      return
    }

    // Move mic audio file if it exists
    var micAudioFileName: String? = nil
    if let audioURL = result.audioURL {
      let audioDestination = containerURL.appendingPathComponent(audioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: audioURL, to: audioDestination)
        micAudioFileName = audioDestination.lastPathComponent
        debugPrint("✅ broadcastFinished: Mic audio saved: \(micAudioFileName!)")
      } catch {
        debugPrint("⚠️ broadcastFinished: Failed to move mic audio: \(error)")
      }
    }

    // Move app audio file if it exists
    var appAudioFileName: String? = nil
    if let appAudioURL = result.appAudioURL {
      let appAudioDestination = containerURL.appendingPathComponent(appAudioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: appAudioURL, to: appAudioDestination)
        appAudioFileName = appAudioDestination.lastPathComponent
        debugPrint("✅ broadcastFinished: App audio saved: \(appAudioFileName!)")
      } catch {
        debugPrint("⚠️ broadcastFinished: Failed to move app audio: \(error)")
      }
    }

    // Build queue entry with all file references together (atomic pairing)
    var entry: [String: Any] = [
      "video": videoDestination.lastPathComponent,
      "micEnabled": sawMicBuffers,
      "hadSeparateAudio": separateAudioFile,
      "timestamp": Date().timeIntervalSince1970,
    ]

    if let id = pendingChunkId {
      entry["chunkId"] = id
    }
    if let mic = micAudioFileName {
      entry["micAudio"] = mic
    }
    if let app = appAudioFileName {
      entry["appAudio"] = app
    }

    // Add to queue (replace if same chunkId exists)
    var chunks = defaults.array(forKey: "PendingChunks") as? [[String: Any]] ?? []

    if let id = pendingChunkId {
      chunks.removeAll { ($0["chunkId"] as? String) == id }
    }

    chunks.append(entry)
    defaults.set(chunks, forKey: "PendingChunks")
    defaults.synchronize()

    debugPrint("✅ broadcastFinished: Added to queue (total: \(chunks.count))")
    debugPrint("   Entry: \(entry)")

    // Clear pendingChunkId
    pendingChunkId = nil

    // Notify main app that chunk is saved and ready for retrieval
    let notif = "com.nitroscreenrecorder.chunkSaved" as CFString
    CFNotificationCenterPostNotification(
      CFNotificationCenterGetDarwinNotifyCenter(),
      CFNotificationName(notif),
      nil,
      nil,
      true
    )
    debugPrint("📤 broadcastFinished: Sent chunkSaved notification")

    // Clear extension status AFTER all file operations complete
    clearExtensionStatus()

    // Deactivate audio session
    do {
      try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      debugPrint("✅ Audio session deactivated")
    } catch {
      debugPrint("⚠️ Failed to deactivate audio session: \(error)")
    }
  }

  /// Clears all extension status from UserDefaults
  private func clearExtensionStatus() {
    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else { return }

    defaults.removeObject(forKey: "ExtensionMicActive")
    defaults.removeObject(forKey: "ExtensionCapturing")
    defaults.removeObject(forKey: "ExtensionChunkStartedAt")
    defaults.synchronize()
  }
}

// MARK: – Helpers
extension FileManager {
  fileprivate func removeFileIfExists(url: URL) {
    guard fileExists(atPath: url.path) else { return }
    try? removeItem(at: url)
  }
}
