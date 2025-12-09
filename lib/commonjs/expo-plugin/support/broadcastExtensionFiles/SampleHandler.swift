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

  // Store both the CFString and CFNotificationName versions
  private static let stopNotificationString = "com.nitroscreenrecorder.stopBroadcast" as CFString
  private static let stopNotificationName = CFNotificationName(stopNotificationString)

  private lazy var hostAppGroupIdentifier: String? = {
    return appGroupIDFromPlist()
  }()

  private var writer: BroadcastWriter?
  private let fileManager: FileManager = .default
  private let nodeURL: URL
  private let audioNodeURL: URL  // Mic audio
  private let appAudioNodeURL: URL  // App/system audio
  private var sawMicBuffers = false
  private var separateAudioFile: Bool = false

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
    CFNotificationCenterRemoveObserver(
      CFNotificationCenterGetDarwinNotifyCenter(),
      UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque()),
      SampleHandler.stopNotificationName,
      nil
    )
  }

  private func startListeningForStopSignal() {
    let center = CFNotificationCenterGetDarwinNotifyCenter()

    CFNotificationCenterAddObserver(
      center,
      UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque()),
      { _, observer, name, _, _ in
        guard
          let observer,
          let name,
          name == SampleHandler.stopNotificationName
        else { return }

        let me = Unmanaged<SampleHandler>
          .fromOpaque(observer)
          .takeUnretainedValue()
        me.stopBroadcastGracefully()
      },
      SampleHandler.stopNotificationString,
      nil,
      .deliverImmediately
    )
  }

  // MARK: – Broadcast lifecycle
  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    startListeningForStopSignal()

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
    guard let writer else { return }

    if sampleBufferType == .audioMic {
      sawMicBuffers = true
    }

    do {
      _ = try writer.processSampleBuffer(sampleBuffer, with: sampleBufferType)
    } catch {
      finishBroadcastWithError(error)
    }
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

  override func broadcastFinished() {
    guard let writer else { return }

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
  }
}

// MARK: – Helpers
extension FileManager {
  fileprivate func removeFileIfExists(url: URL) {
    guard fileExists(atPath: url.path) else { return }
    try? removeItem(at: url)
  }
}
