import AVFoundation
import Foundation
import NitroModules
import ReplayKit
import UIKit

enum RecorderError: Error {
  case error(name: String, message: String)
}

typealias RecordingFinishedCallback = (ScreenRecordingFile) -> Void
typealias ScreenRecordingListener = (ScreenRecordingEvent) -> Void
typealias BroadcastPickerViewListener = (BroadcastPickerPresentationEvent) -> Void

struct Listener<T> {
  let id: Double
  let callback: T
}

struct ScreenRecordingListenerType {
  let id: Double
  let callback: (ScreenRecordingEvent) -> Void
  let ignoreRecordingsInitiatedElsewhere: Bool
}

class NitroScreenRecorder: HybridNitroScreenRecorderSpec {

  let recorder = RPScreenRecorder.shared()
  private var inAppRecordingActive: Bool = false
  private var isGlobalRecordingActive: Bool = false
  private var globalRecordingInitiatedByThisPackage: Bool = false
  private var onInAppRecordingFinishedCallback: RecordingFinishedCallback?
  private var recordingEventListeners: [ScreenRecordingListenerType] = []
  public var broadcastPickerEventListeners: [Listener<BroadcastPickerViewListener>] = []
  private var nextListenerId: Double = 0

  // Separate audio file recording
  private var separateAudioFileEnabled: Bool = false
  private var audioRecorder: AVAudioRecorder?
  private var audioFileURL: URL?

  // App state tracking for broadcast modal
  private var isBroadcastModalShowing: Bool = false
  private var appStateObservers: [NSObjectProtocol] = []

  // Chunk ID for queue-based retrieval (stored locally to avoid race conditions)
  private var currentChunkId: String?

  // Guard against concurrent finalizeChunk calls
  private var isFinalizingChunk: Bool = false

  // Continuation for waiting on chunkSaved notification
  private var chunkSavedContinuation: CheckedContinuation<Void, Never>?

  // Darwin notification names
  private static let chunkSavedNotificationString = "com.nitroscreenrecorder.chunkSaved"
  private static let chunkSavedNotificationName = CFNotificationName("com.nitroscreenrecorder.chunkSaved" as CFString)

  override init() {
    super.init()
    registerListener()
    setupAppStateObservers()
  }

  deinit {
    unregisterListener()
    removeAppStateObservers()
  }

  func registerListener() {
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleScreenRecordingChange),
      name: UIScreen.capturedDidChangeNotification,
      object: nil
    )
  }

  func unregisterListener() {
    NotificationCenter.default.removeObserver(
      self,
      name: UIScreen.capturedDidChangeNotification,
      object: nil
    )
  }

  private func setupAppStateObservers() {
    // Listen for when app becomes active (foreground)
    let willEnterForegroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleAppWillEnterForeground()
    }

    let didBecomeActiveObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.handleAppDidBecomeActive()
    }

    appStateObservers = [willEnterForegroundObserver, didBecomeActiveObserver]
  }

  private func removeAppStateObservers() {
    appStateObservers.forEach { observer in
      NotificationCenter.default.removeObserver(observer)
    }
    appStateObservers.removeAll()
  }

  private func handleAppWillEnterForeground() {

    if isBroadcastModalShowing {
      // The modal was showing and now we're coming back to foreground
      // This likely means the user dismissed the modal or started/cancelled broadcasting
      // Small delay to ensure any system UI transitions are complete
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
        self?.handleBroadcastModalDismissed()
      }
    }
  }

  private func handleAppDidBecomeActive() {
    // Additional check when app becomes fully active
    if isBroadcastModalShowing {
      // Double-check that we're actually back and the modal is gone
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
        guard let self = self else { return }

        // Check if there are any presented view controllers
        guard
          let windowScene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene }).first,
          let window = windowScene.windows.first(where: { $0.isKeyWindow }),
          let rootVC = window.rootViewController
        else {
          return
        }

        var currentVC = rootVC
        var hasModal = false

        while let presentedVC = currentVC.presentedViewController {
          currentVC = presentedVC
          hasModal = true
        }

        // If we thought the modal was showing but there's no modal, it was dismissed
        if !hasModal && self.isBroadcastModalShowing {
          self.handleBroadcastModalDismissed()
        }
      }
    }
  }

  private func handleBroadcastModalDismissed() {
    guard isBroadcastModalShowing else { return }
    isBroadcastModalShowing = false

    // Notify all listeners that the modal was dismissed
    broadcastPickerEventListeners.forEach { $0.callback(.dismissed) }
  }

  @objc private func handleScreenRecordingChange() {
    let type: RecordingEventType
    let reason: RecordingEventReason

    if UIScreen.main.isCaptured {
      reason = .began
      if inAppRecordingActive {
        type = .withinapp
      } else {
        type = .global
        isGlobalRecordingActive = true
      }
    } else {
      reason = .ended
      if inAppRecordingActive {
        type = .withinapp
      } else {
        type = .global
        isGlobalRecordingActive = false
        globalRecordingInitiatedByThisPackage = false  // Reset when global recording ends
      }
    }

    let event = ScreenRecordingEvent(type: type, reason: reason)

    // Filter listeners based on their ignore preference
    recordingEventListeners.forEach { listener in
      let isExternalGlobalRecording = type == .global && !globalRecordingInitiatedByThisPackage
      let shouldIgnore = listener.ignoreRecordingsInitiatedElsewhere && isExternalGlobalRecording

      if !shouldIgnore {
        listener.callback(event)
      }
    }
  }

  func addScreenRecordingListener(
    ignoreRecordingsInitiatedElsewhere: Bool,
    callback: @escaping (ScreenRecordingEvent) -> Void
  ) throws -> Double {
    let listener = ScreenRecordingListenerType(
      id: nextListenerId,
      callback: callback,
      ignoreRecordingsInitiatedElsewhere: ignoreRecordingsInitiatedElsewhere
    )
    recordingEventListeners.append(listener)
    nextListenerId += 1
    return listener.id
  }

  func removeScreenRecordingListener(id: Double) throws {
    recordingEventListeners.removeAll { $0.id == id }
  }

  // MARK: - Permission Methods
  public func getCameraPermissionStatus() throws -> PermissionStatus {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    return self.mapAVAuthorizationStatusToPermissionResponse(status).status
  }

  public func getMicrophonePermissionStatus() throws -> PermissionStatus {
    let status = AVCaptureDevice.authorizationStatus(for: .audio)
    return self.mapAVAuthorizationStatusToPermissionResponse(status).status
  }

  public func requestCameraPermission() throws -> Promise<PermissionResponse> {
    return Promise.async {
      return await withCheckedContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .video) { granted in
          let status = AVCaptureDevice.authorizationStatus(for: .video)
          let result = self.mapAVAuthorizationStatusToPermissionResponse(status)
          continuation.resume(returning: result)
        }
      }
    }
  }

  public func requestMicrophonePermission() throws -> Promise<PermissionResponse> {
    return Promise.async {
      return await withCheckedContinuation { continuation in
        AVCaptureDevice.requestAccess(for: .audio) { granted in
          let status = AVCaptureDevice.authorizationStatus(for: .audio)
          let result = self.mapAVAuthorizationStatusToPermissionResponse(status)
          continuation.resume(returning: result)
        }
      }
    }
  }

  // MARK: - In-App Recording
  func startInAppRecording(
    enableMic: Bool,
    enableCamera: Bool,
    cameraPreviewStyle: RecorderCameraStyle,
    cameraDevice: CameraDevice,
    separateAudioFile: Bool,
    onRecordingFinished: @escaping RecordingFinishedCallback
  ) throws {
    safelyClearInAppRecordingFiles()

    guard recorder.isAvailable else {
      throw RecorderError.error(
        name: "SCREEN_RECORDER_UNAVAILABLE",
        message: "Screen recording is not available"
      )
    }

    if recorder.isRecording {
      print("Recorder is already recording.")
      return
    }

    if enableCamera {
      let camStatus = AVCaptureDevice.authorizationStatus(for: .video)
      guard camStatus == .authorized else {
        throw RecorderError.error(
          name: "CAMERA_PERMISSION_DENIED",
          message: "Camera access is not authorized"
        )
      }
    }
    if enableMic {
      let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
      guard micStatus == .authorized else {
        throw RecorderError.error(
          name: "MIC_PERMISSION_DENIED",
          message: "Microphone access is not authorized"
        )
      }
    }

    self.onInAppRecordingFinishedCallback = onRecordingFinished
    self.separateAudioFileEnabled = separateAudioFile
    recorder.isMicrophoneEnabled = enableMic
    recorder.isCameraEnabled = enableCamera

    if enableCamera {
      let device: RPCameraPosition = (cameraDevice == .front) ? .front : .back
      recorder.cameraPosition = device
    }
    inAppRecordingActive = true

    // Start separate audio recording if enabled and mic is enabled
    if separateAudioFile && enableMic {
      startSeparateAudioRecording()
    }

    recorder.startRecording { [weak self] error in
      guard let self = self else { return }
      if let error = error {
        print("❌ Error starting in-app recording:", error.localizedDescription)
        inAppRecordingActive = false
        self.stopSeparateAudioRecording()
        return
      }
      print(
        "✅ In-app recording started (mic:\(enableMic) camera:\(enableCamera) separateAudio:\(separateAudioFile))"
      )

      if enableCamera {
        DispatchQueue.main.async {
          self.setupAndDisplayCamera(style: cameraPreviewStyle)
        }
      }
    }
  }

  private func startSeparateAudioRecording() {
    let fileName = "audio_capture_\(UUID().uuidString).m4a"
    audioFileURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)

    guard let audioURL = audioFileURL else { return }

    // Remove any existing file
    try? FileManager.default.removeItem(at: audioURL)

    let audioSettings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: 44100.0,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
      AVEncoderBitRateKey: 128000,
    ]

    do {
      // Configure audio session
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(
        .playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
      try audioSession.setActive(true)

      audioRecorder = try AVAudioRecorder(url: audioURL, settings: audioSettings)
      audioRecorder?.record()
      print("✅ Separate audio recording started: \(audioURL.path)")
    } catch {
      print("❌ Failed to start separate audio recording: \(error.localizedDescription)")
      audioRecorder = nil
      audioFileURL = nil
    }
  }

  private func stopSeparateAudioRecording() -> AudioRecordingFile? {
    guard let recorder = audioRecorder, let audioURL = audioFileURL else {
      return nil
    }

    recorder.stop()
    audioRecorder = nil

    // Get audio file info
    do {
      let attrs = try FileManager.default.attributesOfItem(atPath: audioURL.path)
      let asset = AVURLAsset(url: audioURL)
      let duration = CMTimeGetSeconds(asset.duration)

      let audioFile = AudioRecordingFile(
        path: audioURL.absoluteString,
        name: audioURL.lastPathComponent,
        size: attrs[.size] as? Double ?? 0,
        duration: duration
      )

      print("✅ Separate audio recording stopped: \(audioURL.path)")
      return audioFile
    } catch {
      print("❌ Failed to get audio file info: \(error.localizedDescription)")
      return nil
    }
  }

  public func stopInAppRecording() throws -> Promise<ScreenRecordingFile?> {
    return Promise.async {
      return await withCheckedContinuation { continuation in
        // Stop separate audio recording first if enabled
        let audioFile = self.separateAudioFileEnabled ? self.stopSeparateAudioRecording() : nil

        // build a unique temp URL
        let fileName = "screen_capture_\(UUID().uuidString).mp4"
        let outputURL = FileManager.default.temporaryDirectory
          .appendingPathComponent(fileName)

        // remove any existing file
        try? FileManager.default.removeItem(at: outputURL)

        // call the new API
        self.recorder.stopRecording(withOutput: outputURL) { [weak self] error in
          guard let self = self else {
            print("❌ stopInAppRecording: self went away before completion")
            continuation.resume(returning: nil)
            return
          }

          if let error = error {
            print("❌ Error writing recording to \(outputURL):", error.localizedDescription)
            continuation.resume(returning: nil)
            return
          }

          do {
            // read file attributes
            let attrs = try FileManager.default.attributesOfItem(atPath: outputURL.path)
            let asset = AVURLAsset(url: outputURL)
            let duration = CMTimeGetSeconds(asset.duration)

            // build your ScreenRecordingFile
            let file = ScreenRecordingFile(
              path: outputURL.absoluteString,
              name: outputURL.lastPathComponent,
              size: attrs[.size] as? Double ?? 0,
              duration: duration,
              enabledMicrophone: self.recorder.isMicrophoneEnabled,
              audioFile: audioFile,
              appAudioFile: nil  // In-app recording doesn't capture app audio separately
            )

            print("✅ Recording finished and saved to:", outputURL.path)
            if let audioFile = audioFile {
              print("✅ Separate audio file saved to:", audioFile.path)
            }
            self.onInAppRecordingFinishedCallback?(file)
            self.separateAudioFileEnabled = false
            continuation.resume(returning: file)
          } catch {
            print("⚠️ Failed to build ScreenRecordingFile:", error.localizedDescription)
            continuation.resume(returning: nil)
          }
        }
      }
    }
  }

  public func cancelInAppRecording() throws -> Promise<Void> {
    return Promise.async {
      return await withCheckedContinuation { continuation in
        // Stop separate audio recording if active
        if self.separateAudioFileEnabled {
          _ = self.stopSeparateAudioRecording()
          self.separateAudioFileEnabled = false
        }

        // If a recording session is in progress, stop it and write out to a temp URL
        if self.recorder.isRecording {
          let tempURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("canceled_\(UUID().uuidString).mp4")
          self.recorder.stopRecording(withOutput: tempURL) { error in
            if let error = error {
              print("⚠️ Error stopping recording during cancel:", error.localizedDescription)
            } else {
              print("🗑️ In-app recording stopped and wrote to temp URL (canceled):\(tempURL.path)")
            }

            self.safelyClearInAppRecordingFiles()
            print("🛑 In-app recording canceled and buffers cleared")
            continuation.resume(returning: ())
          }
        } else {
          // Not recording, just clear
          self.safelyClearInAppRecordingFiles()
          print("🛑 In-app recording canceled and buffers cleared (no active recording)")
          continuation.resume(returning: ())
        }
      }
    }
  }

  func addBroadcastPickerListener(callback: @escaping (BroadcastPickerPresentationEvent) -> Void)
    throws
    -> Double
  {
    let listener = Listener(id: nextListenerId, callback: callback)
    broadcastPickerEventListeners.append(listener)
    nextListenerId += 1
    return listener.id
  }

  func removeBroadcastPickerListener(id: Double) throws {
    broadcastPickerEventListeners.removeAll { $0.id == id }
  }

  /**
   Attaches a micro PickerView button off-screen and presses that button to open the broadcast.
   */
  func presentGlobalBroadcastModal(enableMicrophone: Bool = true) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }

      let broadcastPicker = RPSystemBroadcastPickerView(
        frame: CGRect(x: 2000, y: 2000, width: 1, height: 1)
      )
      broadcastPicker.preferredExtension = getBroadcastExtensionBundleId()
      broadcastPicker.showsMicrophoneButton = enableMicrophone

      // ① insert off-screen
      guard
        let windowScene = UIApplication.shared
          .connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first,
        let window = windowScene
          .windows
          .first(where: { $0.isKeyWindow })
      else {
        print("❌ No key window found, cannot present broadcast picker")
        return
      }

      // Make the picker invisible but functional
      broadcastPicker.alpha = 0.01
      window.addSubview(broadcastPicker)

      // ② tap the hidden button to bring up the system modal
      if let btn = broadcastPicker
        .subviews
        .compactMap({ $0 as? UIButton })
        .first
      {
        btn.sendActions(for: .touchUpInside)

        // Mark that we're showing the modal
        self.isBroadcastModalShowing = true
        print("🎯 Broadcast modal marked as showing")

        // Notify listeners
        self.broadcastPickerEventListeners.forEach { $0.callback(.showing) }
      }

      // ③ cleanup the picker after some time
      DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
        broadcastPicker.removeFromSuperview()
        print("🎯 Broadcast picker view removed from superview")
      }
    }
  }

  func startGlobalRecording(
    enableMic: Bool, separateAudioFile: Bool, onRecordingError: @escaping (RecordingError) -> Void
  )
    throws
  {
    guard !isGlobalRecordingActive else {
      print("⚠️ Attempted to start a global recording, but one is already active.")
      let error = RecordingError(
        name: "BROADCAST_ALREADY_ACTIVE",
        message: "A screen recording session is already in progress."
      )
      onRecordingError(error)
      return
    }

    // Validate that we can access the app group (needed for global recordings)
    guard let appGroupId = try? getAppGroupIdentifier() else {
      let error = RecordingError(
        name: "APP_GROUP_ACCESS_FAILED",
        message:
          "Could not access app group identifier required for global recording. Something is wrong with your entitlements."
      )
      onRecordingError(error)
      return
    }
    guard
      FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroupId) != nil
    else {
      let error = RecordingError(
        name: "APP_GROUP_CONTAINER_FAILED",
        message:
          "Could not access app group container required for global recording. Something is wrong with your entitlements."
      )
      onRecordingError(error)
      return
    }

    // Store the separateAudioFile preference for the broadcast extension to read
    self.separateAudioFileEnabled = separateAudioFile
    UserDefaults(suiteName: appGroupId)?.set(separateAudioFile, forKey: "SeparateAudioFileEnabled")

    // Present the broadcast picker
    presentGlobalBroadcastModal(enableMicrophone: enableMic)

    // This is sort of a hack to try and track if the user opened the broadcast modal first
    // may not be that reliable, because technically they can open this modal and close it without starting a broadcast
    globalRecordingInitiatedByThisPackage = true

  }
  // This is a hack I learned through:
  // https://mehmetbaykar.com/posts/how-to-gracefully-stop-a-broadcast-upload-extension/
  // Basically you send a kill command through Darwin and you suppress
  // the system error
  func stopGlobalRecording(settledTimeMs: Double) throws -> Promise<ScreenRecordingFile?> {
    return Promise.async {
      // Check both our local flag AND the system's isCaptured state
      // This handles the case where the app was refreshed during recording
      let isScreenCaptured = await MainActor.run { UIScreen.main.isCaptured }

      guard self.isGlobalRecordingActive || isScreenCaptured else {
        print("⚠️ stopGlobalRecording called but no active global recording.")
        do {
          return try self.retrieveLastGlobalRecording()
        } catch {
          print("❌ retrieveLastGlobalRecording failed after stop:", error)
          return nil
        }
      }

      let notif = "com.nitroscreenrecorder.stopBroadcast" as CFString
      CFNotificationCenterPostNotification(
        CFNotificationCenterGetDarwinNotifyCenter(),
        CFNotificationName(notif),
        nil,
        nil,
        true
      )
      // Reflect intent locally.
      self.isGlobalRecordingActive = false
      self.globalRecordingInitiatedByThisPackage = false

      // Wait for the specified settle time to allow the broadcast to finish writing the file.
      let settleTimeNanoseconds = UInt64(settledTimeMs * 1_000_000)  // Convert ms to nanoseconds
      try? await Task.sleep(nanoseconds: settleTimeNanoseconds)

      do {
        return try self.retrieveLastGlobalRecording()
      } catch {
        print("❌ retrieveLastGlobalRecording failed after stop:", error)
        return nil
      }
    }
  }

  // MARK: - Chunk Management for Global Recording

  /**
   Marks the start of a new recording chunk. Discards any content recorded since the last
   markChunkStart() or finalizeChunk() call, and begins recording to a fresh file.
   Use this to indicate "I care about content starting NOW".
   
   - Parameter chunkId: Optional identifier for this chunk. Used for guaranteed correct retrieval.
   */
  func markChunkStart(chunkId: String?) throws {
    // Check both our local flag AND the system's isCaptured state
    // This handles the case where the app was refreshed during recording
    guard isGlobalRecordingActive || UIScreen.main.isCaptured else {
      print("⚠️ markChunkStart called but no active global recording.")
      return
    }

    // Store chunkId locally to avoid race conditions when finalizeChunk reads it
    self.currentChunkId = chunkId

    // Also store in UserDefaults for the broadcast extension to read
    if let appGroupId = try? getAppGroupIdentifier() {
      let defaults = UserDefaults(suiteName: appGroupId)
      if let id = chunkId {
        defaults?.set(id, forKey: "CurrentChunkId")
      } else {
        defaults?.removeObject(forKey: "CurrentChunkId")
      }
      defaults?.synchronize()
    }

    // Send notification twice for reliability (Darwin notifications can be dropped)
    let notif = "com.nitroscreenrecorder.markChunk" as CFString
    let darwinCenter = CFNotificationCenterGetDarwinNotifyCenter()
    CFNotificationCenterPostNotification(darwinCenter, CFNotificationName(notif), nil, nil, true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
      CFNotificationCenterPostNotification(darwinCenter, CFNotificationName(notif), nil, nil, true)
    }
    print("📍 markChunkStart: Notification sent to broadcast extension, chunkId=\(chunkId ?? "nil")")
  }

  /**
   Finalizes the current recording chunk and returns it, then starts a new chunk.
   The recording session continues uninterrupted.
   Returns the video file containing content from the last markChunkStart() (or recording start) until now.
   Uses event-driven waiting: listens for chunkSaved notification from extension.
   */
  func finalizeChunk(settledTimeMs: Double) throws -> Promise<ScreenRecordingFile?> {
    return Promise.async {
      // Guard against concurrent calls
      guard !self.isFinalizingChunk else {
        print("⚠️ finalizeChunk called while another finalize is in progress. Rejecting.")
        return nil
      }
      self.isFinalizingChunk = true
      defer { self.isFinalizingChunk = false }

      // Check both our local flag AND the system's isCaptured state
      // This handles the case where the app was refreshed during recording
      let isScreenCaptured = await MainActor.run { UIScreen.main.isCaptured }

      guard self.isGlobalRecordingActive || isScreenCaptured else {
        print("⚠️ finalizeChunk called but no active global recording.")
        return nil
      }

      // Capture the chunkId NOW from local storage (not UserDefaults)
      // This prevents race condition if markChunkStart is called again before retrieve
      let chunkIdToRetrieve = self.currentChunkId

      // Setup listener for chunkSaved notification BEFORE sending finalizeChunk
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      let observer = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())

      CFNotificationCenterAddObserver(
        center,
        observer,
        { _, observer, name, _, _ in
          guard let observer else { return }
          let me = Unmanaged<NitroScreenRecorder>.fromOpaque(observer).takeUnretainedValue()
          // Resume continuation if waiting
          if let cont = me.chunkSavedContinuation {
            me.chunkSavedContinuation = nil
            cont.resume()
          }
        },
        NitroScreenRecorder.chunkSavedNotificationString as CFString,
        nil,
        .deliverImmediately
      )

      // Send finalizeChunk notification to extension (send twice for reliability)
      let notif = "com.nitroscreenrecorder.finalizeChunk" as CFString
      let darwinCenter = CFNotificationCenterGetDarwinNotifyCenter()
      CFNotificationCenterPostNotification(darwinCenter, CFNotificationName(notif), nil, nil, true)
      // Small delay then send again to increase delivery reliability
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
        CFNotificationCenterPostNotification(darwinCenter, CFNotificationName(notif), nil, nil, true)
      }

      // Wait for chunkSaved signal OR timeout - then fall back to polling
      // Wait 500ms for notification, then poll aggressively
      let notificationWaitNs = UInt64(500_000_000)  // 500ms for notification

      // Race between notification and timeout
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        self.chunkSavedContinuation = continuation

        // Start timeout task (short wait)
        Task {
          try? await Task.sleep(nanoseconds: notificationWaitNs)
          // If continuation still exists, we timed out
          if let cont = self.chunkSavedContinuation {
            self.chunkSavedContinuation = nil
            cont.resume()
          }
        }
      }

      // Remove observer
      CFNotificationCenterRemoveObserver(
        center,
        observer,
        NitroScreenRecorder.chunkSavedNotificationName,
        nil
      )

      // Try to retrieve with aggressive polling if first attempt fails
      do {
        if let file = try self.retrieveGlobalRecording(chunkId: chunkIdToRetrieve) {
          return file
        }

        // Poll up to 15 times, 200ms apart (~3 second total extra wait)
        for attempt in 1...15 {
          print("⚠️ Retrieval returned nil, polling attempt \(attempt)/15...")
          try? await Task.sleep(nanoseconds: 200_000_000)  // 200ms

          if let file = try self.retrieveGlobalRecording(chunkId: chunkIdToRetrieve) {
            print("✅ Polling attempt \(attempt) succeeded")
            return file
          }
        }

        print("❌ All polling attempts returned nil")
        return nil
      } catch {
        print("❌ retrieveGlobalRecording failed after finalizeChunk:", error)
        return nil
      }
    }
  }

  func retrieveLastGlobalRecording() throws -> ScreenRecordingFile? {
    // Resolve app group documents directory
    guard let appGroupId = try? getAppGroupIdentifier(),
      let docsURL = FileManager.default
        .containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else {
      throw RecorderError.error(
        name: "APP_GROUP_ACCESS_FAILED",
        message: "Could not access app group container"
      )
    }

    // Ensure directory exists (in case first run)
    let fm = FileManager.default
    if !fm.fileExists(atPath: docsURL.path) {
      try fm.createDirectory(
        at: docsURL, withIntermediateDirectories: true, attributes: nil
      )
    }

    // Get all .mp4 files and sort by creation date (FIFO - oldest first)
    let contents = try fm.contentsOfDirectory(
      at: docsURL,
      includingPropertiesForKeys: [.creationDateKey],
      options: [.skipsHiddenFiles]
    )

    let mp4s = contents
      .filter { $0.pathExtension.lowercased() == "mp4" }
      .sorted { url1, url2 in
        let date1 = (try? url1.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? Date.distantPast
        let date2 = (try? url2.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? Date.distantPast
        return date1 < date2  // Oldest first (FIFO)
      }

    // If none, return nil
    guard let sourceURL = mp4s.first else { return nil }
    
    print("📦 retrieveLastGlobalRecording: Found \(mp4s.count) chunk(s), retrieving oldest: \(sourceURL.lastPathComponent)")

    // Prepare local caches destination
    let cachesURL = try fm.url(
      for: .cachesDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let recordingsDir = cachesURL.appendingPathComponent(
      "ScreenRecordings", isDirectory: true
    )
    if !fm.fileExists(atPath: recordingsDir.path) {
      try fm.createDirectory(
        at: recordingsDir, withIntermediateDirectories: true, attributes: nil
      )
    }

    // Destination file (use same name; avoid collision by appending timestamp)
    var destinationURL =
      recordingsDir.appendingPathComponent(sourceURL.lastPathComponent)
    if fm.fileExists(atPath: destinationURL.path) {
      let ts = Int(Date().timeIntervalSince1970)
      let base = sourceURL.deletingPathExtension().lastPathComponent
      destinationURL = recordingsDir.appendingPathComponent("\(base)-\(ts).mp4")
    }

    // Copy into caches, then delete from shared container (FIFO queue behavior)
    try fm.copyItem(at: sourceURL, to: destinationURL)
    try? fm.removeItem(at: sourceURL)  // Remove from container so next retrieval gets the next chunk
    print("📦 retrieveLastGlobalRecording: Moved chunk to cache, removed from container")

    // Build ScreenRecordingFile from the local copy
    let attrs = try fm.attributesOfItem(atPath: destinationURL.path)
    let size = (attrs[.size] as? NSNumber)?.doubleValue ?? 0.0

    let asset = AVURLAsset(url: destinationURL)
    let duration = CMTimeGetSeconds(asset.duration)

    let micEnabled =
      UserDefaults(suiteName: appGroupId)?
      .bool(forKey: "LastBroadcastMicrophoneWasEnabled") ?? false

    // Check for and retrieve separate mic audio file
    var audioFile: AudioRecordingFile? = nil
    let hadSeparateAudio =
      UserDefaults(suiteName: appGroupId)?.bool(forKey: "LastBroadcastHadSeparateAudio") ?? false

    if hadSeparateAudio,
      let audioFileName = UserDefaults(suiteName: appGroupId)?.string(
        forKey: "LastBroadcastAudioFileName")
    {
      let audioSourceURL = docsURL.appendingPathComponent(audioFileName)

      if fm.fileExists(atPath: audioSourceURL.path) {
        // Copy mic audio file to caches
        var audioDestinationURL = recordingsDir.appendingPathComponent(audioFileName)
        if fm.fileExists(atPath: audioDestinationURL.path) {
          let ts = Int(Date().timeIntervalSince1970)
          let base = audioSourceURL.deletingPathExtension().lastPathComponent
          audioDestinationURL = recordingsDir.appendingPathComponent("\(base)-\(ts).m4a")
        }

        do {
          try fm.copyItem(at: audioSourceURL, to: audioDestinationURL)
          try? fm.removeItem(at: audioSourceURL)  // Remove from container

          let audioAttrs = try fm.attributesOfItem(atPath: audioDestinationURL.path)
          let audioSize = (audioAttrs[.size] as? NSNumber)?.doubleValue ?? 0.0

          let audioAsset = AVURLAsset(url: audioDestinationURL)
          let audioDuration = CMTimeGetSeconds(audioAsset.duration)

          audioFile = AudioRecordingFile(
            path: audioDestinationURL.absoluteString,
            name: audioDestinationURL.lastPathComponent,
            size: audioSize,
            duration: audioDuration
          )
          print("✅ Retrieved separate mic audio file: \(audioDestinationURL.path)")
        } catch {
          print("⚠️ Failed to copy mic audio file: \(error.localizedDescription)")
        }
      }
    }

    // Check for and retrieve separate app audio file
    var appAudioFile: AudioRecordingFile? = nil

    if hadSeparateAudio,
      let appAudioFileName = UserDefaults(suiteName: appGroupId)?.string(
        forKey: "LastBroadcastAppAudioFileName")
    {
      let appAudioSourceURL = docsURL.appendingPathComponent(appAudioFileName)

      if fm.fileExists(atPath: appAudioSourceURL.path) {
        // Copy app audio file to caches
        var appAudioDestinationURL = recordingsDir.appendingPathComponent(appAudioFileName)
        if fm.fileExists(atPath: appAudioDestinationURL.path) {
          let ts = Int(Date().timeIntervalSince1970)
          let base = appAudioSourceURL.deletingPathExtension().lastPathComponent
          appAudioDestinationURL = recordingsDir.appendingPathComponent("\(base)-\(ts).m4a")
        }

        do {
          try fm.copyItem(at: appAudioSourceURL, to: appAudioDestinationURL)
          try? fm.removeItem(at: appAudioSourceURL)  // Remove from container

          let appAudioAttrs = try fm.attributesOfItem(atPath: appAudioDestinationURL.path)
          let appAudioSize = (appAudioAttrs[.size] as? NSNumber)?.doubleValue ?? 0.0

          let appAudioAsset = AVURLAsset(url: appAudioDestinationURL)
          let appAudioDuration = CMTimeGetSeconds(appAudioAsset.duration)

          appAudioFile = AudioRecordingFile(
            path: appAudioDestinationURL.absoluteString,
            name: appAudioDestinationURL.lastPathComponent,
            size: appAudioSize,
            duration: appAudioDuration
          )
          print("✅ Retrieved separate app audio file: \(appAudioDestinationURL.path)")
        } catch {
          print("⚠️ Failed to copy app audio file: \(error.localizedDescription)")
        }
      }
    }

    return ScreenRecordingFile(
      path: destinationURL.absoluteString,
      name: destinationURL.lastPathComponent,
      size: size,
      duration: duration,
      enabledMicrophone: micEnabled,
      audioFile: audioFile,
      appAudioFile: appAudioFile
    )
  }

  /**
   Queue-based retrieval of global recording chunks.
   If chunkId is provided, retrieves that specific chunk.
   If chunkId is nil, retrieves the newest chunk (LIFO order).
   Returns nil if no matching chunk is found.
   */
  func retrieveGlobalRecording(chunkId: String?) throws -> ScreenRecordingFile? {
    let fm = FileManager.default

    guard let appGroupId = try? getAppGroupIdentifier(),
      let docsURL = fm
        .containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?
        .appendingPathComponent("Library/Documents/", isDirectory: true),
      let defaults = UserDefaults(suiteName: appGroupId)
    else {
      throw RecorderError.error(
        name: "APP_GROUP_ACCESS_FAILED",
        message: "Could not access app group container"
      )
    }

    // Read queue
    var chunks = defaults.array(forKey: "PendingChunks") as? [[String: Any]] ?? []

    if chunks.isEmpty {
      print("⚠️ retrieveGlobalRecording: Queue is empty - extension may not have saved the chunk")
      return nil
    }

    // Find chunk to retrieve
    let chunkIndex: Int
    let chunkEntry: [String: Any]

    if let targetId = chunkId {
      // Find by ID
      if let idx = chunks.firstIndex(where: { ($0["chunkId"] as? String) == targetId }) {
        chunkIndex = idx
        chunkEntry = chunks[idx]
        print("📦 retrieveGlobalRecording: Found chunk by ID '\(targetId)' at index \(idx)")
      } else {
        print("⚠️ retrieveGlobalRecording: Chunk not found with ID '\(targetId)'")
        print("   Available chunks: \(chunks.compactMap { $0["chunkId"] as? String })")
        // Fallback to LIFO if ID not found
        chunkIndex = chunks.count - 1
        chunkEntry = chunks[chunkIndex]
        print("📦 retrieveGlobalRecording: Falling back to LIFO (index \(chunkIndex))")
      }
    } else {
      // LIFO fallback: get newest (last in array)
      chunkIndex = chunks.count - 1
      chunkEntry = chunks[chunkIndex]
      print("📦 retrieveGlobalRecording: No ID specified, using LIFO (index \(chunkIndex))")
    }

    // Extract chunk info
    guard let videoFileName = chunkEntry["video"] as? String else {
      print("❌ retrieveGlobalRecording: Chunk entry missing 'video' field")
      return nil
    }
    let micAudioFileName = chunkEntry["micAudio"] as? String
    let appAudioFileName = chunkEntry["appAudio"] as? String
    let micEnabled = chunkEntry["micEnabled"] as? Bool ?? false
    let hadSeparateAudio = chunkEntry["hadSeparateAudio"] as? Bool ?? false

    // Verify video file exists
    let videoSourceURL = docsURL.appendingPathComponent(videoFileName)
    guard fm.fileExists(atPath: videoSourceURL.path) else {
      print("⚠️ retrieveGlobalRecording: Video file not found at \(videoSourceURL.path)")
      print("   Removing orphaned queue entry")
      chunks.remove(at: chunkIndex)
      defaults.set(chunks, forKey: "PendingChunks")
      defaults.synchronize()
      return nil
    }

    // Setup caches directory
    let cachesURL = try fm.url(
      for: .cachesDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let recordingsDir = cachesURL.appendingPathComponent("ScreenRecordings", isDirectory: true)
    try fm.createDirectory(at: recordingsDir, withIntermediateDirectories: true)

    // STEP 1: Copy video to caches
    var videoDestURL = recordingsDir.appendingPathComponent(videoFileName)
    if fm.fileExists(atPath: videoDestURL.path) {
      let ts = Int(Date().timeIntervalSince1970)
      let base = videoSourceURL.deletingPathExtension().lastPathComponent
      videoDestURL = recordingsDir.appendingPathComponent("\(base)-\(ts).mp4")
    }
    try fm.copyItem(at: videoSourceURL, to: videoDestURL)
    print("✅ Copied video to caches: \(videoFileName)")

    // STEP 2: Copy audio files (if they exist)
    var audioFile: AudioRecordingFile? = nil
    if hadSeparateAudio, let micFileName = micAudioFileName {
      let micSourceURL = docsURL.appendingPathComponent(micFileName)
      if fm.fileExists(atPath: micSourceURL.path) {
        var micDestURL = recordingsDir.appendingPathComponent(micFileName)
        if fm.fileExists(atPath: micDestURL.path) {
          let ts = Int(Date().timeIntervalSince1970)
          let base = micSourceURL.deletingPathExtension().lastPathComponent
          micDestURL = recordingsDir.appendingPathComponent("\(base)-\(ts).m4a")
        }
        do {
          try fm.copyItem(at: micSourceURL, to: micDestURL)

          let micAttrs = try fm.attributesOfItem(atPath: micDestURL.path)
          let micSize = (micAttrs[.size] as? NSNumber)?.doubleValue ?? 0.0
          let micAsset = AVURLAsset(url: micDestURL)
          let micDuration = CMTimeGetSeconds(micAsset.duration)

          audioFile = AudioRecordingFile(
            path: micDestURL.absoluteString,
            name: micDestURL.lastPathComponent,
            size: micSize,
            duration: micDuration
          )
          print("✅ Copied mic audio to caches: \(micFileName)")
        } catch {
          print("⚠️ Failed to copy mic audio: \(error)")
        }
      }
    }

    var appAudioFile: AudioRecordingFile? = nil
    if hadSeparateAudio, let appFileName = appAudioFileName {
      let appSourceURL = docsURL.appendingPathComponent(appFileName)
      if fm.fileExists(atPath: appSourceURL.path) {
        var appDestURL = recordingsDir.appendingPathComponent(appFileName)
        if fm.fileExists(atPath: appDestURL.path) {
          let ts = Int(Date().timeIntervalSince1970)
          let base = appSourceURL.deletingPathExtension().lastPathComponent
          appDestURL = recordingsDir.appendingPathComponent("\(base)-\(ts).m4a")
        }
        do {
          try fm.copyItem(at: appSourceURL, to: appDestURL)

          let appAttrs = try fm.attributesOfItem(atPath: appDestURL.path)
          let appSize = (appAttrs[.size] as? NSNumber)?.doubleValue ?? 0.0
          let appAsset = AVURLAsset(url: appDestURL)
          let appDuration = CMTimeGetSeconds(appAsset.duration)

          appAudioFile = AudioRecordingFile(
            path: appDestURL.absoluteString,
            name: appDestURL.lastPathComponent,
            size: appSize,
            duration: appDuration
          )
          print("✅ Copied app audio to caches: \(appFileName)")
        } catch {
          print("⚠️ Failed to copy app audio: \(error)")
        }
      }
    }

    // STEP 3: Remove from queue AFTER successful copy (prevents duplicates)
    chunks.remove(at: chunkIndex)
    defaults.set(chunks, forKey: "PendingChunks")
    defaults.synchronize()
    print("✅ Removed chunk from queue")

    // STEP 4: Delete from container (best effort - failure is OK now)
    do {
      try fm.removeItem(at: videoSourceURL)
      print("✅ Deleted video from container")
    } catch {
      print("⚠️ Failed to delete video from container (non-critical): \(error)")
    }

    if let micFileName = micAudioFileName {
      let micSourceURL = docsURL.appendingPathComponent(micFileName)
      try? fm.removeItem(at: micSourceURL)
    }
    if let appFileName = appAudioFileName {
      let appSourceURL = docsURL.appendingPathComponent(appFileName)
      try? fm.removeItem(at: appSourceURL)
    }

    // Build result
    let attrs = try fm.attributesOfItem(atPath: videoDestURL.path)
    let size = (attrs[.size] as? NSNumber)?.doubleValue ?? 0.0
    let asset = AVURLAsset(url: videoDestURL)
    let duration = CMTimeGetSeconds(asset.duration)

    print("✅ retrieveGlobalRecording complete: \(videoFileName), duration=\(duration)s")

    return ScreenRecordingFile(
      path: videoDestURL.absoluteString,
      name: videoDestURL.lastPathComponent,
      size: size,
      duration: duration,
      enabledMicrophone: micEnabled,
      audioFile: audioFile,
      appAudioFile: appAudioFile
    )
  }

  func safelyClearGlobalRecordingFiles() throws {
    let fm = FileManager.default

    guard let appGroupId = try? getAppGroupIdentifier(),
      let docsURL =
        fm
        .containerURL(forSecurityApplicationGroupIdentifier: appGroupId)?
        .appendingPathComponent("Library/Documents/", isDirectory: true)
    else {
      throw RecorderError.error(
        name: "APP_GROUP_ACCESS_FAILED",
        message: "Could not access app group container"
      )
    }

    do {
      guard fm.fileExists(atPath: docsURL.path) else { return }
      let items = try fm.contentsOfDirectory(at: docsURL, includingPropertiesForKeys: nil)
      for fileURL in items {
        let ext = fileURL.pathExtension.lowercased()
        // Delete video and audio files
        if ext == "mp4" || ext == "m4a" {
          try fm.removeItem(at: fileURL)
          print("🗑️ Deleted: \(fileURL.lastPathComponent)")
        }
      }
      print("✅ All recording files cleared in \(docsURL.path)")
    } catch {
      throw RecorderError.error(
        name: "CLEANUP_FAILED",
        message: "Could not clear recording files: \(error.localizedDescription)"
      )
    }

    // Also clear the pending chunks queue
    if let defaults = UserDefaults(suiteName: appGroupId) {
      defaults.removeObject(forKey: "PendingChunks")
      defaults.removeObject(forKey: "CurrentChunkId")
      defaults.synchronize()
      print("✅ Cleared PendingChunks queue")
    }
  }

  func safelyClearInAppRecordingFiles() {
    recorder.discardRecording {
      print("✅ In‑app recording discarded")
    }
  }

  func clearRecordingCache() throws {
    try safelyClearGlobalRecordingFiles()
    safelyClearInAppRecordingFiles()
  }

  // MARK: - Extension Status & Logs

  /**
   Returns logs from the broadcast extension for debugging.
   Logs are stored in UserDefaults by the extension and retrieved here.
   Returns an array of log entry strings in format: "[LEVEL] timestamp: message"
   */
  func getExtensionLogs() throws -> [String] {
    guard let appGroupId = try? getAppGroupIdentifier(),
          let defaults = UserDefaults(suiteName: appGroupId)
    else {
      return ["Error: Could not access app group"]
    }
    
    guard let logs = defaults.array(forKey: "ExtensionLogs") as? [[String: Any]] else {
      return ["No logs available"]
    }
    
    return logs.compactMap { entry in
      guard let level = entry["level"] as? String,
            let time = entry["time"] as? String,
            let message = entry["message"] as? String
      else { return nil }
      return "[\(level)] \(time): \(message)"
    }
  }

  /**
   Clears all extension logs from UserDefaults.
   */
  func clearExtensionLogs() throws {
    guard let appGroupId = try? getAppGroupIdentifier(),
          let defaults = UserDefaults(suiteName: appGroupId)
    else {
      return
    }
    
    defaults.removeObject(forKey: "ExtensionLogs")
    defaults.synchronize()
  }

  /**
   Returns the current status of the broadcast extension by reading from shared UserDefaults.
   Includes heartbeat, mic status, and chunk status.
   */
  func getExtensionStatus() throws -> RawExtensionStatus {
    guard let appGroupId = try? getAppGroupIdentifier(),
      let defaults = UserDefaults(suiteName: appGroupId)
    else {
      return RawExtensionStatus(
        isMicrophoneEnabled: false,
        isCapturingChunk: false,
        chunkStartedAt: 0,
        captureMode: .entirescreen  // iOS always captures entire screen
      )
    }

    let isMicrophoneEnabled = defaults.bool(forKey: "ExtensionMicActive")
    let isCapturingChunk = defaults.bool(forKey: "ExtensionCapturing")
    let chunkStartedAt = defaults.double(forKey: "ExtensionChunkStartedAt")

    return RawExtensionStatus(
      isMicrophoneEnabled: isMicrophoneEnabled,
      isCapturingChunk: isCapturingChunk,
      chunkStartedAt: chunkStartedAt,
      captureMode: .entirescreen  // iOS always captures entire screen
    )
  }

  /**
   Returns whether the screen is currently being recorded.
   Uses UIScreen.main.isCaptured which is instant and reliable.
   */
  func isScreenBeingRecorded() throws -> Bool {
    return UIScreen.main.isCaptured
  }
}
