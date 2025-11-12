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
import android.os.IBinder
import android.util.Log
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

  private var screenWidth = 0
  private var screenHeight = 0
  private var screenDensity = 0
  private var startId: Int = -1

  private val binder = LocalBinder()

  private val mediaProjectionCallback = object : MediaProjection.Callback() {
    override fun onStop() {
      Log.d(TAG, "📱 MediaProjection stopped")
      if (isRecording) {
        stopRecording()
      }
    }
  }

  companion object {
    private const val TAG = "ScreenRecordingService"
    private const val NOTIFICATION_ID = 1001
    private const val CHANNEL_ID = "screen_recording_channel"
    const val ACTION_START_RECORDING = "START_RECORDING"
    const val ACTION_STOP_RECORDING = "STOP_RECORDING"
    const val EXTRA_RESULT_CODE = "RESULT_CODE"
    const val EXTRA_RESULT_DATA = "RESULT_DATA"
    const val EXTRA_ENABLE_MIC = "ENABLE_MIC"
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

        Log.d(
          TAG,
          "🎬 Start recording: resultCode=$resultCode, enableMic=$enableMicrophone"
        )

        if (resultData != null) {
          startRecording(resultCode, resultData, enableMicrophone)
        } else {
          Log.e(TAG, "❌ ResultData is null, cannot start recording")
        }
      }
      ACTION_STOP_RECORDING -> {
        Log.d(TAG, "🛑 Stop recording action received")
        stopRecording()
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
    enableMicrophone: Boolean
  ) {
    Log.d(
      TAG,
      "🎬 startRecording called: resultCode=$resultCode, enableMic=$enableMicrophone"
    )

    if (isRecording) {
      Log.w(TAG, "⚠️ Already recording")
      return
    }

    try {
      this.enableMic = enableMicrophone

      startForeground(NOTIFICATION_ID, createForegroundNotification(false))

      val mediaProjectionManager =
        getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      mediaProjection =
        mediaProjectionManager.getMediaProjection(resultCode, resultData)

      // Register the callback BEFORE creating VirtualDisplay
      mediaProjection?.registerCallback(mediaProjectionCallback, null)

      // write into the app-specific external cache (no runtime READ_EXTERNAL_STORAGE needed)
      val base = applicationContext.externalCacheDir
        ?: applicationContext.filesDir
      val recordingsDir = File(base, "recordings")
      currentRecordingFile =
        RecorderUtils.createOutputFile(recordingsDir, "global_recording")

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

      val notificationManager = getSystemService(NotificationManager::class.java)
      notificationManager.notify(NOTIFICATION_ID, createForegroundNotification(true))

      val event = ScreenRecordingEvent(
        type = RecordingEventType.GLOBAL,
        reason = RecordingEventReason.BEGAN
      )
      NitroScreenRecorder.notifyGlobalRecordingEvent(event)

      Log.d(TAG, "🎉 Global screen recording started successfully")

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

    if (!isRecording) {
      Log.w(TAG, "⚠️ Not recording")
      return null
    }

    var recordingFile: File? = null

    try {
      mediaRecorder?.stop()
      isRecording = false
      recordingFile = currentRecordingFile

      // Optimize MP4 for streaming (faststart)
      recordingFile?.let {
        recordingFile = RecorderUtils.optimizeForStreaming(it)
      }

      val event = ScreenRecordingEvent(
        type = RecordingEventType.GLOBAL,
        reason = RecordingEventReason.ENDED
      )
      recordingFile?.let {
        NitroScreenRecorder.notifyGlobalRecordingFinished(it, event, enableMic)
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

  private fun cleanup() {
    Log.d(TAG, "🧹 cleanup() called")

    try {
      virtualDisplay?.release()
      virtualDisplay = null
      mediaRecorder?.release()
      mediaRecorder = null

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
