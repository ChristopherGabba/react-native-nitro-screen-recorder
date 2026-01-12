package com.margelo.nitro.nitroscreenrecorder

import android.app.*
import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import com.margelo.nitro.nitroscreenrecorder.utils.RecorderUtils
import java.io.File

class ScreenRecordingService : Service() {

  private var mediaProjection: MediaProjection? = null
  private var mediaRecorder: MediaRecorder? = null
  private var virtualDisplay: VirtualDisplay? = null
  private var isRecording = false
  private var currentRecordingFile: File? = null
  private var enableMic = false
  
  // Separate audio file extraction (done post-recording)
  private var separateAudioFile = false
  private var currentAudioFile: File? = null

  // Chunking state
  // NOTE: On Android 14+ (API 34+), MediaProjection only allows ONE VirtualDisplay per token.
  // We use timestamp-based chunking: markChunkStart records timestamp, finalizeChunk stops & returns file.
  private var isCapturing = false
  private var chunkStartedAt: Double = 0.0
  private var recordingStartedAt: Double = 0.0
  
  // Capture mode (Android 14+)
  // Defaults to ENTIRESCREEN on Android 14+, updated to SINGLEAPP when visibility callback fires with false
  private var captureMode: CaptureMode = CaptureMode.UNKNOWN
  private var isSingleAppMode = false

  private var screenWidth = 0
  private var screenHeight = 0
  private var screenDensity = 0
  private var startId: Int = -1
  private val mainHandler = Handler(Looper.getMainLooper())

  private val binder = LocalBinder()

  private val mediaProjectionCallback = object : MediaProjection.Callback() {
    override fun onStop() {
      Log.d(TAG, "📱 MediaProjection stopped")
      if (isRecording) {
        stopRecording()
      }
    }
    
    // Android 14+ (API 34): Called when captured content visibility changes
    // On Android 14/15, this callback fires for BOTH modes:
    // - isVisible=true fires initially for both modes
    // - isVisible=false ONLY fires in single-app mode when user navigates away
    // So we can only reliably detect single-app mode when isVisible=false
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    override fun onCapturedContentVisibilityChanged(isVisible: Boolean) {
      super.onCapturedContentVisibilityChanged(isVisible)
      Log.d(TAG, "📱 Captured content visibility changed: isVisible=$isVisible")
      
      if (!isVisible) {
        // isVisible=false ONLY happens in single-app mode when user navigates away
        Log.d(TAG, "📱 isVisible=false → Confirmed SINGLE APP mode")
        isSingleAppMode = true
        captureMode = CaptureMode.SINGLEAPP
      } else {
        // isVisible=true fires for both modes initially, not conclusive
        Log.d(TAG, "📱 isVisible=true → Could be either mode, keeping current: $captureMode")
      }
    }
    
    // Android 14+ (API 34): Called when captured content is resized
    // NOTE: This callback fires for both entire screen and single-app mode with varying dimensions
    // due to status bar, navigation bar, etc. It's NOT a reliable indicator of capture mode.
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    override fun onCapturedContentResize(width: Int, height: Int) {
      super.onCapturedContentResize(width, height)
      Log.d(TAG, "📱 Captured content resized: ${width}x${height} (screen: ${screenWidth}x${screenHeight})")
      // Don't use this to determine capture mode - onCapturedContentVisibilityChanged is the reliable indicator
    }
  }

  companion object {
    private const val TAG = "ScreenRecordingService"
    private const val NOTIFICATION_ID = 1001
    private const val CHANNEL_ID = "screen_recording_channel"
    const val ACTION_START_RECORDING = "START_RECORDING"
    const val ACTION_STOP_RECORDING = "STOP_RECORDING"
    const val ACTION_MARK_CHUNK_START = "MARK_CHUNK_START"
    const val ACTION_FINALIZE_CHUNK = "FINALIZE_CHUNK"
    const val EXTRA_RESULT_CODE = "RESULT_CODE"
    const val EXTRA_RESULT_DATA = "RESULT_DATA"
    const val EXTRA_ENABLE_MIC = "ENABLE_MIC"
    const val EXTRA_SEPARATE_AUDIO = "SEPARATE_AUDIO"
  }

  inner class LocalBinder : Binder() {
    fun getService(): ScreenRecordingService = this@ScreenRecordingService
  }

  override fun onCreate() {
    super.onCreate()
    Log.d(TAG, "🚀 ScreenRecordingService onCreate called")
    RecorderUtils.createNotificationChannel(
      this,
      CHANNEL_ID,
      "Screen Recording",
      "Screen recording notification"
    )
    val metrics = RecorderUtils.initializeScreenMetrics(this)
    screenWidth = metrics.width
    screenHeight = metrics.height
    screenDensity = metrics.density
    Log.d(TAG, "✅ ScreenRecordingService created successfully")
  }

  override fun onBind(intent: Intent?): IBinder {
    Log.d(TAG, "🔗 onBind called")
    return binder
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.d(TAG, "🚀 onStartCommand called with action: ${intent?.action}")

    this.startId = startId

    when (intent?.action) {
      ACTION_START_RECORDING -> {
        val resultCode =
          intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
        val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val enableMicrophone = intent.getBooleanExtra(EXTRA_ENABLE_MIC, false)
        val separateAudio = intent.getBooleanExtra(EXTRA_SEPARATE_AUDIO, false)

        Log.d(
          TAG,
          "🎬 Start recording: resultCode=$resultCode, enableMic=$enableMicrophone, separateAudio=$separateAudio"
        )

        if (resultData != null) {
          startRecording(resultCode, resultData, enableMicrophone, separateAudio)
        } else {
          Log.e(TAG, "❌ ResultData is null, cannot start recording")
        }
      }
      ACTION_STOP_RECORDING -> {
        Log.d(TAG, "🛑 Stop recording action received")
        stopRecording()
      }
      ACTION_MARK_CHUNK_START -> {
        Log.d(TAG, "📍 Mark chunk start action received")
        markChunkStart()
      }
      ACTION_FINALIZE_CHUNK -> {
        Log.d(TAG, "📦 Finalize chunk action received")
        // Note: finalizeChunk returns file synchronously, but we handle it via callback
      }
    }

    return START_NOT_STICKY
  }

  private fun createForegroundNotification(isRecording: Boolean): Notification {
    Log.d(TAG, "🔔 Creating foreground notification: isRecording=$isRecording")

    val stopIntent = Intent(this, ScreenRecordingService::class.java).apply {
      action = ACTION_STOP_RECORDING
    }
    val stopPendingIntent = PendingIntent.getService(
      this,
      0,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(if (isRecording) "Recording screen..." else "Screen recording")
      .setContentText(
        if (isRecording) "Tap to stop recording" else "Preparing to record"
      )
      .setSmallIcon(android.R.drawable.ic_media_play)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .apply {
        if (isRecording) {
          addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
        }
      }
      .build()
  }

  fun startRecording(
    resultCode: Int,
    resultData: Intent,
    enableMicrophone: Boolean,
    separateAudio: Boolean = false
  ) {
    Log.d(
      TAG,
      "🎬 startRecording called: resultCode=$resultCode, enableMic=$enableMicrophone, separateAudio=$separateAudio"
    )

    if (isRecording) {
      Log.w(TAG, "⚠️ Already recording")
      return
    }
    
    // If there's an existing MediaProjection (e.g., from before hot reload), clean it up first
    if (mediaProjection != null) {
      Log.w(TAG, "🧹 Cleaning up stale MediaProjection before starting new recording")
      cleanup()
    }

    try {
      this.enableMic = enableMicrophone
      this.separateAudioFile = separateAudio
      
      // Reset chunking state
      isCapturing = false
      chunkStartedAt = 0.0
      
      // On Android 14+, we default to ENTIRESCREEN.
      // If user selected single-app mode and navigates away, onCapturedContentVisibilityChanged(false)
      // will fire and we'll update to SINGLEAPP.
      // On older Android versions, capture mode is always UNKNOWN (no user choice).
      captureMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        CaptureMode.ENTIRESCREEN
      } else {
        CaptureMode.UNKNOWN
      }
      isSingleAppMode = false

      startForeground(NOTIFICATION_ID, createForegroundNotification(false))

      val mediaProjectionManager =
        getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      mediaProjection =
        mediaProjectionManager.getMediaProjection(resultCode, resultData)

      // Register the callback BEFORE creating VirtualDisplay
      mediaProjection?.registerCallback(mediaProjectionCallback, mainHandler)

      // write into the app-specific external cache (no runtime READ_EXTERNAL_STORAGE needed)
      val base = applicationContext.externalCacheDir
        ?: applicationContext.filesDir
      val recordingsDir = File(base, "recordings")
      currentRecordingFile =
        RecorderUtils.createOutputFile(recordingsDir, "global_recording")

      // Record video with audio embedded normally
      // If separateAudioFile is requested, we'll extract it after recording stops
      mediaRecorder = RecorderUtils.setupMediaRecorder(
        this,
        enableMicrophone,
        currentRecordingFile!!,
        screenWidth,
        screenHeight,
        8 * 1024 * 1024
      ) // 8 Mbps
      mediaRecorder?.prepare()

      virtualDisplay = mediaProjection?.createVirtualDisplay(
        "GlobalScreenRecording",
        screenWidth,
        screenHeight,
        screenDensity,
        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
        mediaRecorder?.surface,
        null,
        null
      )

      mediaRecorder?.start()
      isRecording = true
      recordingStartedAt = System.currentTimeMillis() / 1000.0

      val notificationManager = getSystemService(NotificationManager::class.java)
      notificationManager.notify(NOTIFICATION_ID, createForegroundNotification(true))

      val event = ScreenRecordingEvent(
        type = RecordingEventType.GLOBAL,
        reason = RecordingEventReason.BEGAN
      )
      NitroScreenRecorder.notifyGlobalRecordingEvent(event)

      Log.d(TAG, "🎉 Global screen recording started successfully")
      Log.d(TAG, "📺 Capture mode: $captureMode (will update to SINGLEAPP if user navigates away)")

    } catch (e: Exception) {
      Log.e(TAG, "❌ Error starting global recording: ${e.message}")
      e.printStackTrace()
      val error = RecordingError(
        name = "RecordingStartError",
        message = e.message ?: "Failed to start recording"
      )
      NitroScreenRecorder.notifyGlobalRecordingError(error)
      cleanup()
      stopSelf(this.startId)
    }
  }

  fun stopRecording(): File? {
    Log.d(TAG, "🛑 stopRecording called")

    // Handle case where we're paused between chunks (no active recorder but session exists)
    if (!isRecording && mediaProjection != null) {
      Log.d(TAG, "📍 Stopping paused session (no active recorder)")
      val event = ScreenRecordingEvent(
        type = RecordingEventType.GLOBAL,
        reason = RecordingEventReason.ENDED
      )
      NitroScreenRecorder.notifyGlobalRecordingEvent(event)
      cleanup()
      stopForeground(true)
      stopSelf(this.startId)
      return null
    }

    if (!isRecording) {
      Log.w(TAG, "⚠️ Not recording and no session")
      return null
    }

    var recordingFile: File? = null
    var audioFile: File? = null

    try {
      mediaRecorder?.stop()
      isRecording = false
      recordingFile = currentRecordingFile

      // Optimize MP4 for streaming (faststart)
      recordingFile?.let {
        recordingFile = RecorderUtils.optimizeForStreaming(it)
      }

      // Extract audio to separate file if requested and mic was enabled
      if (separateAudioFile && enableMic && recordingFile != null) {
        val base = applicationContext.externalCacheDir ?: applicationContext.filesDir
        val recordingsDir = File(base, "recordings")
        currentAudioFile = RecorderUtils.createAudioOutputFile(recordingsDir, "global_recording_audio")
        
        val extracted = RecorderUtils.extractAudioFromVideo(recordingFile!!, currentAudioFile!!)
        if (extracted) {
          audioFile = currentAudioFile
          Log.d(TAG, "🎵 Audio extracted to separate file: ${audioFile?.absolutePath}")
        } else {
          Log.w(TAG, "⚠️ Failed to extract audio from video")
          currentAudioFile?.delete()
          currentAudioFile = null
        }
      }

      val event = ScreenRecordingEvent(
        type = RecordingEventType.GLOBAL,
        reason = RecordingEventReason.ENDED
      )
      recordingFile?.let {
        NitroScreenRecorder.notifyGlobalRecordingFinished(it, audioFile, event, enableMic)
      }

      Log.d(TAG, "🎉 Global screen recording stopped successfully")

    } catch (e: Exception) {
      Log.e(TAG, "❌ Error stopping global recording: ${e.message}")
      e.printStackTrace()
      val error = RecordingError(
        name = "RecordingStopError",
        message = e.message ?: "Failed to stop recording"
      )
      NitroScreenRecorder.notifyGlobalRecordingError(error)
    } finally {
      cleanup()
      stopForeground(true)
      stopSelf(this.startId)
    }

    return recordingFile
  }

  /**
   * Marks the start of a new chunk using VirtualDisplay.setSurface() for seamless swap.
   * 
   * On Android 14+ (API 34+), you cannot create multiple VirtualDisplays from the same
   * MediaProjection token. However, you CAN swap the surface on an existing VirtualDisplay
   * using setSurface(). This allows seamless chunking:
   * 
   * 1. Create a new MediaRecorder with a new output file
   * 2. Swap the VirtualDisplay surface to the new recorder's surface
   * 3. Start the new recorder, stop the old one (if any)
   * 4. Discard the pre-chunk content (old file)
   * 
   * Can be called:
   * - After startGlobalRecording() to begin first chunk (discards pre-chunk content)
   * - After finalizeChunk() to begin next chunk (VirtualDisplay still exists, no active recorder)
   */
  fun markChunkStart() {
    Log.d(TAG, "📍 markChunkStart called")

    if (virtualDisplay == null) {
      Log.w(TAG, "⚠️ markChunkStart: No VirtualDisplay - call startGlobalRecording first")
      val error = RecordingError(
        name = "ChunkStartError",
        message = "No active recording session. Call startGlobalRecording first."
      )
      NitroScreenRecorder.notifyGlobalRecordingError(error)
      return
    }

    try {
      // Save references to old recorder/file (may be null if coming from finalizeChunk)
      val oldRecorder = mediaRecorder
      val oldFile = currentRecordingFile

      // Create new recording file for the chunk
      val base = applicationContext.externalCacheDir ?: applicationContext.filesDir
      val recordingsDir = File(base, "recordings")
      val newRecordingFile = RecorderUtils.createOutputFile(recordingsDir, "chunk")

      // Create and prepare new MediaRecorder
      val newRecorder = RecorderUtils.setupMediaRecorder(
        this,
        enableMic,
        newRecordingFile,
        screenWidth,
        screenHeight,
        8 * 1024 * 1024
      )
      newRecorder.prepare()

      // IMPORTANT: Start the new recorder BEFORE swapping the surface
      // This ensures frames are written to a fully initialized recorder
      newRecorder.start()
      Log.d(TAG, "📍 New chunk recorder started")

      // SEAMLESS SWAP: Update the VirtualDisplay surface to point to new recorder
      // This redirects the screen capture to the running recorder
      virtualDisplay?.setSurface(newRecorder.surface)
      Log.d(TAG, "📍 VirtualDisplay surface swapped to new recorder")

      // Update references
      mediaRecorder = newRecorder
      currentRecordingFile = newRecordingFile
      isRecording = true

      // Clean up old recorder if it exists (content is pre-chunk, discard it)
      if (oldRecorder != null) {
        try {
          oldRecorder.stop()
          oldRecorder.release()
          // Delete the old file - this was pre-chunk content
          oldFile?.delete()
          Log.d(TAG, "📍 Old recorder stopped and pre-chunk content discarded")
        } catch (e: Exception) {
          Log.w(TAG, "⚠️ Error stopping old recorder: ${e.message}")
          // Still try to delete the file
          oldFile?.delete()
        }
      } else {
        Log.d(TAG, "📍 No old recorder (starting fresh chunk after finalize)")
      }

      // Update chunking state
      isCapturing = true
      chunkStartedAt = System.currentTimeMillis() / 1000.0

      Log.d(TAG, "📍 Chunk started at $chunkStartedAt (seamless surface swap)")

    } catch (e: Exception) {
      Log.e(TAG, "❌ Error in markChunkStart: ${e.message}")
      e.printStackTrace()
      val error = RecordingError(
        name = "ChunkStartError",
        message = e.message ?: "Failed to start chunk"
      )
      NitroScreenRecorder.notifyGlobalRecordingError(error)
    }
  }

  /**
   * Finalizes the current chunk by stopping the recorder and returning the file.
   * 
   * The MediaProjection and VirtualDisplay remain active, allowing you to call
   * markChunkStart() again to begin recording a new chunk without re-prompting
   * the user for permission.
   * 
   * Flow: startGlobalRecording -> markChunkStart -> finalizeChunk -> markChunkStart -> finalizeChunk -> ... -> stopGlobalRecording
   */
  fun finalizeChunk(): File? {
    Log.d(TAG, "📦 finalizeChunk called")

    if (!isCapturing) {
      Log.w(TAG, "⚠️ finalizeChunk: Not currently capturing a chunk (markChunkStart not called)")
      return null
    }

    if (mediaRecorder == null) {
      Log.w(TAG, "⚠️ finalizeChunk: No active recorder")
      return null
    }

    var chunkFile: File? = null

    try {
      val chunkEndedAt = System.currentTimeMillis() / 1000.0
      val chunkDuration = chunkEndedAt - chunkStartedAt
      Log.d(TAG, "📦 Chunk duration: ${chunkDuration}s (from $chunkStartedAt to $chunkEndedAt)")

      // IMPORTANT: Set surface to null FIRST to stop receiving new frames
      // This prevents frames from being sent to a recorder that's being stopped
      virtualDisplay?.setSurface(null)
      Log.d(TAG, "📦 VirtualDisplay surface cleared (paused)")

      // Now stop and release the recorder
      mediaRecorder?.stop()
      mediaRecorder?.release()
      mediaRecorder = null

      chunkFile = currentRecordingFile
      currentRecordingFile = null

      // Optimize for streaming
      chunkFile?.let {
        chunkFile = RecorderUtils.optimizeForStreaming(it)
      }

      // Extract audio to separate file if requested and mic was enabled
      if (separateAudioFile && enableMic && chunkFile != null) {
        val base = applicationContext.externalCacheDir ?: applicationContext.filesDir
        val recordingsDir = File(base, "recordings")
        val audioFile = RecorderUtils.createAudioOutputFile(recordingsDir, "chunk_audio")
        
        val extracted = RecorderUtils.extractAudioFromVideo(chunkFile!!, audioFile)
        if (extracted) {
          currentAudioFile = audioFile
          Log.d(TAG, "🎵 Chunk audio extracted to: ${audioFile.absolutePath}")
        } else {
          Log.w(TAG, "⚠️ Failed to extract audio from chunk")
          audioFile.delete()
        }
      }

      // Update state - chunk done, but recording session still active
      isCapturing = false
      chunkStartedAt = 0.0
      // Keep isRecording = false to indicate paused state
      // MediaProjection stays alive for next markChunkStart()
      isRecording = false

      Log.d(TAG, "📦 Chunk finalized: ${chunkFile?.absolutePath}")
      Log.d(TAG, "ℹ️ Call markChunkStart() to begin next chunk, or stopGlobalRecording() to end session")

    } catch (e: Exception) {
      Log.e(TAG, "❌ Error in finalizeChunk: ${e.message}")
      e.printStackTrace()
      val error = RecordingError(
        name = "ChunkFinalizeError",
        message = e.message ?: "Failed to finalize chunk"
      )
      NitroScreenRecorder.notifyGlobalRecordingError(error)
    }

    return chunkFile
  }

  // Status getters for NitroScreenRecorder
  fun isCapturingChunk(): Boolean = isCapturing
  fun getChunkStartedAt(): Double = chunkStartedAt
  fun getCaptureMode(): CaptureMode = captureMode
  fun isMicrophoneEnabled(): Boolean = enableMic
  fun getLastAudioFile(): File? = currentAudioFile
  
  /** Returns true if we have an active MediaProjection session (even if paused between chunks) */
  fun hasActiveSession(): Boolean = mediaProjection != null

  private fun cleanup() {
    Log.d(TAG, "🧹 cleanup() called")

    try {
      virtualDisplay?.release()
      virtualDisplay = null
      mediaRecorder?.release()
      mediaRecorder = null
      
      // Reset audio file state
      currentAudioFile = null
      separateAudioFile = false
      
      // Reset chunking state
      isCapturing = false
      chunkStartedAt = 0.0
      recordingStartedAt = 0.0
      
      // Reset capture mode
      captureMode = CaptureMode.UNKNOWN
      isSingleAppMode = false

      // Unregister callback before stopping MediaProjection
      mediaProjection?.unregisterCallback(mediaProjectionCallback)
      mediaProjection?.stop()
      mediaProjection = null

      Log.d(TAG, "✅ Cleanup completed")
    } catch (e: Exception) {
      Log.e(TAG, "❌ Error during cleanup: ${e.message}")
    }
  }

  fun isCurrentlyRecording(): Boolean = isRecording

  override fun onDestroy() {
    Log.d(TAG, "💀 onDestroy called")
    cleanup()
    super.onDestroy()
  }
}
