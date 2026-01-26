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

  // Chunk ID for queue-based retrieval (captured at markChunk, used at save)
  private var pendingChunkId: String?

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

    // Configure audio session for Bluetooth support (AirPods, etc.)
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(
        .playAndRecord,
        mode: .videoRecording,
        options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
      )
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
      debugPrint("✅ Audio session configured for broadcast with Bluetooth support")
    } catch {
      debugPrint("⚠️ Failed to configure audio session: \(error)")
    }

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

    // Also clear the stale pending chunks queue from previous sessions
    if let defaults = UserDefaults(suiteName: groupID) {
      defaults.removeObject(forKey: "PendingChunks")
      defaults.removeObject(forKey: "CurrentChunkId")
      defaults.synchronize()
      debugPrint("✅ Cleared stale PendingChunks queue")
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
   Captures the chunkId from UserDefaults at the START of this chunk.
   */
  // Debounce tracking for duplicate notification protection
  private var lastMarkChunkTime: TimeInterval = 0
  private var lastFinalizeChunkTime: TimeInterval = 0
  private let debounceThreshold: TimeInterval = 0.1  // 100ms debounce

  private func handleMarkChunk() {
    writerQueue.sync {
      // Debounce: ignore if called within 100ms of last call
      let now = Date().timeIntervalSince1970
      if now - self.lastMarkChunkTime < self.debounceThreshold {
        debugPrint("📍 handleMarkChunk: Ignoring duplicate notification (debounce)")
        return
      }
      self.lastMarkChunkTime = now

      debugPrint("📍 handleMarkChunk: Discarding current chunk and starting fresh")
      self.isCapturing = true
      self.chunkStartedAt = Date().timeIntervalSince1970

      // Capture chunkId at the START of this chunk (before it could be overwritten)
      if let groupID = hostAppGroupIdentifier {
        self.pendingChunkId = UserDefaults(suiteName: groupID)?.string(forKey: "CurrentChunkId")
        debugPrint("📍 handleMarkChunk: Captured chunkId=\(self.pendingChunkId ?? "nil")")
      }

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
      // Debounce: ignore if called within 100ms of last call
      let now = Date().timeIntervalSince1970
      if now - self.lastFinalizeChunkTime < self.debounceThreshold {
        debugPrint("📦 handleFinalizeChunk: Ignoring duplicate notification (debounce)")
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
      self.lastFinalizeChunkTime = now

      debugPrint("📦 handleFinalizeChunk: Saving current chunk and starting fresh")

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
        debugPrint("📤 handleFinalizeChunk: Sent chunkSaved notification")
      }

      guard let currentWriter = self.writer else {
        debugPrint("⚠️ handleFinalizeChunk: No active writer - creating new one")
        self.createNewWriter()
        sendChunkNotification()  // Notify so main app doesn't hang
        return
      }

      // Finish current writer and get the result
      let result: BroadcastWriter.FinishResult
      do {
        result = try currentWriter.finishWithAudio()
        debugPrint("📦 handleFinalizeChunk: Writer finished successfully")
      } catch {
        debugPrint("❌ handleFinalizeChunk: Error finishing writer: \(error)")
        // Release the failed writer explicitly
        self.writer = nil
        // Still try to create a new writer so recording can continue
        self.createNewWriter()
        sendChunkNotification()  // Notify so main app doesn't hang
        return
      }

      // Release the finished writer before creating new one
      self.writer = nil

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
    // Explicitly release old writer reference first
    writer = nil
    
    let screen: UIScreen = .main
    var attempts = 0
    let maxAttempts = 3
    
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
        debugPrint("✅ createNewWriter: New writer created and started (attempt \(attempts))")
        return  // Success, exit
      } catch {
        debugPrint("❌ createNewWriter: Attempt \(attempts)/\(maxAttempts) failed: \(error)")
        writer = nil
        
        if attempts < maxAttempts {
          // Brief delay before retry to let resources release
          Thread.sleep(forTimeInterval: 0.05)  // 50ms (reduced from 150ms)
        }
      }
    }
    
    debugPrint("❌ createNewWriter: All \(maxAttempts) attempts failed - writer is nil")
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
      debugPrint("📤 saveChunkToContainer: Sent chunkSaved notification")
    }
    
    guard let groupID = hostAppGroupIdentifier,
      let defaults = UserDefaults(suiteName: groupID)
    else {
      debugPrint("⚠️ saveChunkToContainer: No app group identifier")
      sendChunkNotification()  // Still notify so main app doesn't hang
      return
    }

    guard
      let containerURL =
        fileManager
        .containerURL(forSecurityApplicationGroupIdentifier: groupID)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else {
      debugPrint("⚠️ saveChunkToContainer: Could not get container URL")
      sendChunkNotification()
      return
    }

    // Create directory if needed
    do {
      try fileManager.createDirectory(at: containerURL, withIntermediateDirectories: true)
    } catch {
      debugPrint("⚠️ saveChunkToContainer: Could not create directory: \(error)")
      sendChunkNotification()
      return
    }

    // Move video file to shared container
    let videoDestination = containerURL.appendingPathComponent(result.videoURL.lastPathComponent)
    do {
      try fileManager.moveItem(at: result.videoURL, to: videoDestination)
      debugPrint("✅ saveChunkToContainer: Video saved to \(videoDestination.lastPathComponent)")
    } catch {
      debugPrint("❌ saveChunkToContainer: Failed to move video: \(error)")
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
        debugPrint("✅ saveChunkToContainer: Mic audio saved: \(micAudioFileName!)")
      } catch {
        debugPrint("⚠️ saveChunkToContainer: Failed to move mic audio: \(error)")
      }
    }

    // Move app audio file if it exists
    var appAudioFileName: String? = nil
    if let appAudioURL = result.appAudioURL {
      let appAudioDestination = containerURL.appendingPathComponent(appAudioURL.lastPathComponent)
      do {
        try fileManager.moveItem(at: appAudioURL, to: appAudioDestination)
        appAudioFileName = appAudioDestination.lastPathComponent
        debugPrint("✅ saveChunkToContainer: App audio saved: \(appAudioFileName!)")
      } catch {
        debugPrint("⚠️ saveChunkToContainer: Failed to move app audio: \(error)")
      }
    }

    // Build queue entry with all file references together (atomic pairing)
    var entry: [String: Any] = [
      "video": videoDestination.lastPathComponent,
      "micEnabled": sawMicBuffers,
      "hadSeparateAudio": separateAudioFile,
      "timestamp": Date().timeIntervalSince1970
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

    debugPrint("✅ saveChunkToContainer: Added to queue (total: \(chunks.count))")
    debugPrint("   Entry: \(entry)")

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
    debugPrint("📤 saveChunkToContainer: Sent chunkSaved notification")
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
      "timestamp": Date().timeIntervalSince1970
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
