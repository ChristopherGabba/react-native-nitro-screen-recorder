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

    guard let groupID = hostAppGroupIdentifier else {
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
    } catch {
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
  }

  override func processSampleBuffer(
    _ sampleBuffer: CMSampleBuffer,
    with sampleBufferType: RPSampleBufferType
  ) {
    // Use sync to ensure thread safety with writer swaps
    writerQueue.sync {
      guard let writer = self.writer else { return }

      if sampleBufferType == .audioMic {
        self.sawMicBuffers = true
      }

      // Update status periodically (not every frame)
      if sampleBufferType == .video {
        self.frameCount += 1
        if self.frameCount >= self.statusUpdateInterval {
          self.frameCount = 0
          self.updateExtensionStatus()
        }
      }

      do {
        _ = try writer.processSampleBuffer(sampleBuffer, with: sampleBufferType)
      } catch {
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
   */
  private func handleMarkChunk() {
    writerQueue.sync {
      debugPrint("📍 handleMarkChunk: Discarding current chunk and starting fresh")
      self.isCapturing = true
      self.chunkStartedAt = Date().timeIntervalSince1970

      // Finish current writer without saving
      if let currentWriter = self.writer {
        do {
          _ = try currentWriter.finishWithAudio()
          debugPrint("📍 handleMarkChunk: Previous writer finished (discarded)")
        } catch {
          debugPrint("⚠️ handleMarkChunk: Error finishing previous writer: \(error)")
        }
      }

      // Delete the temp files (don't save them)
      self.fileManager.removeFileIfExists(url: self.nodeURL)
      self.fileManager.removeFileIfExists(url: self.audioNodeURL)
      self.fileManager.removeFileIfExists(url: self.appAudioNodeURL)

      // Create new writer with fresh file URLs
      self.createNewWriter()
      debugPrint("📍 handleMarkChunk: New chunk started")
    }
  }

  /**
   Handles finalizeChunk: Saves the current recording to the shared container and starts a fresh one.
   The saved file can be retrieved by the main app.
   */
  private func handleFinalizeChunk() {
    writerQueue.sync {
      debugPrint("📦 handleFinalizeChunk: Saving current chunk and starting fresh")

      // Mark capturing as done (will restart with next markChunkStart)
      self.isCapturing = false
      self.chunkStartedAt = 0

      guard let currentWriter = self.writer else {
        debugPrint("⚠️ handleFinalizeChunk: No active writer")
        return
      }

      // Finish current writer and get the result
      let result: BroadcastWriter.FinishResult
      do {
        result = try currentWriter.finishWithAudio()
        debugPrint("📦 handleFinalizeChunk: Writer finished successfully")
      } catch {
        debugPrint("❌ handleFinalizeChunk: Error finishing writer: \(error)")
        // Still try to create a new writer so recording can continue
        self.createNewWriter()
        return
      }

      // Save the chunk to shared container
      self.saveChunkToContainer(result: result)

      // Create new writer with fresh file URLs
      self.createNewWriter()
      debugPrint("📦 handleFinalizeChunk: New chunk started")
    }
  }

  /**
   Creates a new BroadcastWriter with fresh file URLs.
   Must be called from within writerQueue.
   */
  private func createNewWriter() {
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

    // Clean up any existing files at these paths
    fileManager.removeFileIfExists(url: nodeURL)
    fileManager.removeFileIfExists(url: audioNodeURL)
    fileManager.removeFileIfExists(url: appAudioNodeURL)

    // Create and start the new writer
    let screen: UIScreen = .main
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
      debugPrint("✅ createNewWriter: New writer created and started")
    } catch {
      debugPrint("❌ createNewWriter: Failed to create new writer: \(error)")
      writer = nil
    }
  }

  /**
   Saves a finished chunk to the shared App Group container.
   Must be called from within writerQueue.
   */
  private func saveChunkToContainer(result: BroadcastWriter.FinishResult) {
    guard let groupID = hostAppGroupIdentifier else {
      debugPrint("⚠️ saveChunkToContainer: No app group identifier")
      return
    }

    guard
      let containerURL =
        fileManager
        .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else {
      debugPrint("⚠️ saveChunkToContainer: Could not get container URL")
      return
    }

    // Create directory if needed
    do {
      try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
    } catch {
      debugPrint("⚠️ saveChunkToContainer: Could not create directory: \(error)")
      return
    }

    // Clean up old recordings first (we only keep the latest chunk)
    cleanupOldRecordings(in: groupID)

    // Move video file to shared container
    let videoDestination = containerURL.appendingPathComponent(result.videoURL.lastPathComponent)
    do {
      try fileManager.moveItem(at: result.videoURL, to: videoDestination)
      debugPrint("✅ saveChunkToContainer: Video saved to \(videoDestination.lastPathComponent)")
    } catch {
      debugPrint("❌ saveChunkToContainer: Failed to move video: \(error)")
      return
    }

    // Move mic audio file if it exists
    if let audioURL = result.audioURL {
      let audioDestination = containerURL.appendingPathComponent(audioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: audioURL, to: audioDestination)
        UserDefaults(suiteName: groupID)?
          .set(audioDestination.lastPathComponent, forKey: "LastBroadcastAudioFileName")
        debugPrint("✅ saveChunkToContainer: Mic audio saved")
      } catch {
        debugPrint("⚠️ saveChunkToContainer: Failed to move mic audio: \(error)")
      }
    } else {
      UserDefaults(suiteName: groupID)?.removeObject(forKey: "LastBroadcastAudioFileName")
    }

    // Move app audio file if it exists
    if let appAudioURL = result.appAudioURL {
      let appAudioDestination = containerURL.appendingPathComponent(appAudioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: appAudioURL, to: appAudioDestination)
        UserDefaults(suiteName: groupID)?
          .set(appAudioDestination.lastPathComponent, forKey: "LastBroadcastAppAudioFileName")
        debugPrint("✅ saveChunkToContainer: App audio saved")
      } catch {
        debugPrint("⚠️ saveChunkToContainer: Failed to move app audio: \(error)")
      }
    } else {
      UserDefaults(suiteName: groupID)?.removeObject(forKey: "LastBroadcastAppAudioFileName")
    }

    // Persist metadata
    UserDefaults(suiteName: groupID)?.set(
      sawMicBuffers, forKey: "LastBroadcastMicrophoneWasEnabled")
    UserDefaults(suiteName: groupID)?.set(
      separateAudioFile, forKey: "LastBroadcastHadSeparateAudio")
  }

  override func broadcastFinished() {
    guard let writer else {
      clearExtensionStatus()
      return
    }

    // Finish writing - use finishWithAudio to get both video and audio URLs
    let result: BroadcastWriter.FinishResult
    do {
      result = try writer.finishWithAudio()
    } catch {
      // Writer failed, but we can't call finishBroadcastWithError here
      // as we're already in the finish process
      return
    }

    guard let groupID = hostAppGroupIdentifier else { return }

    // Get container directory
    guard
      let containerURL =
        fileManager
        .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else { return }

    // Create directory if needed
    do {
      try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
    } catch {
      return
    }

    // Move video file to shared container
    let videoDestination = containerURL.appendingPathComponent(result.videoURL.lastPathComponent)
    do {
      try fileManager.moveItem(at: result.videoURL, to: videoDestination)
    } catch {
      // File move failed, but we can't error out at this point
      return
    }

    // Move mic audio file to shared container if it exists
    if let audioURL = result.audioURL {
      let audioDestination = containerURL.appendingPathComponent(audioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: audioURL, to: audioDestination)
        // Store mic audio file name for retrieval
        UserDefaults(suiteName: groupID)?
          .set(audioDestination.lastPathComponent, forKey: "LastBroadcastAudioFileName")
      } catch {
        // Audio file move failed, but video is already saved
        debugPrint("Failed to move mic audio file: \(error)")
      }
    } else {
      // Clear mic audio file name if no separate audio
      UserDefaults(suiteName: groupID)?
        .removeObject(forKey: "LastBroadcastAudioFileName")
    }

    // Move app audio file to shared container if it exists
    if let appAudioURL = result.appAudioURL {
      let appAudioDestination = containerURL.appendingPathComponent(appAudioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: appAudioURL, to: appAudioDestination)
        // Store app audio file name for retrieval
        UserDefaults(suiteName: groupID)?
          .set(appAudioDestination.lastPathComponent, forKey: "LastBroadcastAppAudioFileName")
      } catch {
        // App audio file move failed, but video is already saved
        debugPrint("Failed to move app audio file: \(error)")
      }
    } else {
      // Clear app audio file name if no separate audio
      UserDefaults(suiteName: groupID)?
        .removeObject(forKey: "LastBroadcastAppAudioFileName")
    }

    // Persist microphone state and audio file state
    UserDefaults(suiteName: groupID)?
      .set(sawMicBuffers, forKey: "LastBroadcastMicrophoneWasEnabled")
    UserDefaults(suiteName: groupID)?
      .set(separateAudioFile, forKey: "LastBroadcastHadSeparateAudio")

    // Clear extension status AFTER all file operations complete
    clearExtensionStatus()
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
