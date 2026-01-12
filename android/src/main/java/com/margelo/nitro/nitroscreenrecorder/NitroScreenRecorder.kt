package com.margelo.nitro.nitroscreenrecorder

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.*
import com.margelo.nitro.nitroscreenrecorder.utils.RecorderUtils
import java.io.File
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlinx.coroutines.delay

data class Listener<T>(val id: Double, val callback: T)

@DoNotStrip
class NitroScreenRecorder : HybridNitroScreenRecorderSpec() {

  private lateinit var mediaProjectionManager: MediaProjectionManager

  // Global recording properties
  private var globalRecordingService: ScreenRecordingService? = null
  private var isServiceBound = false
  private var lastGlobalRecording: File? = null
  private var lastGlobalAudioRecording: File? = null
  private var globalRecordingErrorCallback: ((RecordingError) -> Unit)? = null

  private val screenRecordingListeners =
    mutableListOf<Listener<(ScreenRecordingEvent) -> Unit>>()
  private var nextListenerId = 0.0

  companion object {
    private const val TAG = "NitroScreenRecorder"
    var sharedRequestCode = 10
    private const val GLOBAL_RECORDING_REQUEST_CODE = 1001

    private var instance: NitroScreenRecorder? = null

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
      Log.d(
        TAG,
        "🎯 Static handleActivityResult called: requestCode=$requestCode, resultCode=$resultCode"
      )
      instance?.handleActivityResult(requestCode, resultCode, data)
    }

    fun notifyGlobalRecordingEvent(event: ScreenRecordingEvent) {
      Log.d(
        TAG,
        "🔔 notifyGlobalRecordingEvent called with type: ${event.type}, reason: ${event.reason}"
      )
      instance?.notifyListeners(event)
    }

    fun notifyGlobalRecordingFinished(
      file: File,
      audioFile: File?,
      event: ScreenRecordingEvent,
      enabledMic: Boolean
    ) {
      Log.d(TAG, "🏁 notifyGlobalRecordingFinished called with file: ${file.absolutePath}, audioFile: ${audioFile?.absolutePath}")
      instance?.let { recorder ->
        recorder.lastGlobalRecording = file
        recorder.lastGlobalAudioRecording = audioFile
        recorder.notifyListeners(event)
      }
    }

    fun notifyGlobalRecordingError(error: RecordingError) {
      Log.e(
        TAG,
        "❌ notifyGlobalRecordingError called with error: ${error.name} - ${error.message}"
      )
      instance?.globalRecordingErrorCallback?.invoke(error)
    }
  }

  init {
    Log.d(TAG, "🚀 NitroScreenRecorder init block started")
    NitroModules.applicationContext?.let { ctx ->
      mediaProjectionManager =
        ctx.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      instance = this
      
      // Try to rebind to existing service if it's running (handles hot reload case)
      if (isServiceRunning(ctx)) {
        Log.d(TAG, "🔄 Service is running, attempting to rebind...")
        rebindToExistingService(ctx)
      }
      
      Log.d(TAG, "✅ NitroScreenRecorder initialization complete")
    } ?: run {
      Log.e(TAG, "❌ NitroScreenRecorder: applicationContext was null")
    }
  }
  
  /**
   * Check if the ScreenRecordingService is currently running.
   * This works even if we're not bound to the service.
   */
  @Suppress("DEPRECATION")
  private fun isServiceRunning(context: Context): Boolean {
    val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
    for (service in manager.getRunningServices(Int.MAX_VALUE)) {
      if (ScreenRecordingService::class.java.name == service.service.className) {
        return true
      }
    }
    return false
  }
  
  /**
   * Attempt to rebind to an existing ScreenRecordingService.
   * Called on init to handle hot reload scenarios.
   */
  private fun rebindToExistingService(context: Context) {
    if (isServiceBound) {
      Log.d(TAG, "Already bound to service")
      return
    }
    
    val intent = Intent(context, ScreenRecordingService::class.java)
    try {
      context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
      Log.d(TAG, "🔗 Rebind to existing service initiated")
    } catch (e: Exception) {
      Log.e(TAG, "❌ Failed to rebind to service: ${e.message}")
    }
  }

  private fun notifyListeners(event: ScreenRecordingEvent) {
    Log.d(
      TAG,
      "🔔 notifyListeners called with ${screenRecordingListeners.size} listeners, event: ${event.type}/${event.reason}"
    )
    screenRecordingListeners.forEach { listener ->
      try {
        listener.callback(event)
      } catch (e: Exception) {
        Log.e(TAG, "❌ Error in screen recording listener ${listener.id}: ${e.message}")
      }
    }
  }

  override fun addScreenRecordingListener(
    ignoreRecordingsInitiatedElsewhere: Boolean,
    callback: (ScreenRecordingEvent) -> Unit
  ): Double {
    val id = nextListenerId++
    screenRecordingListeners += Listener(id, callback)
    Log.d(
      TAG,
      "👂 Added screen recording listener with ID: $id, total listeners: ${screenRecordingListeners.size}"
    )
    return id
  }

  override fun removeScreenRecordingListener(id: Double) {
    screenRecordingListeners.removeAll { it.id == id }
  }

  override fun addBroadcastPickerListener(
    callback: (BroadcastPickerPresentationEvent) -> Unit
  ): Double {
    // No-op on Android - broadcast picker is iOS-only concept
    return 0.0
  }

  override fun removeBroadcastPickerListener(id: Double) {
    // No-op on Android - broadcast picker is iOS-only concept  
  }

  // Service connection for Global Recording
  private val serviceConnection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
      val binder = service as ScreenRecordingService.LocalBinder
      globalRecordingService = binder.getService()
      isServiceBound = true
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      globalRecordingService = null
      isServiceBound = false
    }
  }

  private fun canRequestPermission(permission: String): Boolean {
    return NitroModules.applicationContext?.let { ctx ->
      val activity = ctx.currentActivity ?: return false
      !activity.shouldShowRequestPermissionRationale(permission) ||
        activity.shouldShowRequestPermissionRationale(permission)
    } ?: false
  }

  private fun mapToPermissionStatus(status: Int): PermissionStatus {
    return when (status) {
      PackageManager.PERMISSION_DENIED -> PermissionStatus.DENIED
      PackageManager.PERMISSION_GRANTED -> PermissionStatus.GRANTED
      else -> PermissionStatus.UNDETERMINED
    }
  }

  private fun getPermission(permission: String): PermissionStatus {
    return NitroModules.applicationContext?.let { ctx ->
      val status = ContextCompat.checkSelfPermission(ctx, permission)
      var parsed = mapToPermissionStatus(status)
      if (parsed == PermissionStatus.DENIED && canRequestPermission(permission)) {
        parsed = PermissionStatus.UNDETERMINED
      }
      parsed
    } ?: PermissionStatus.UNDETERMINED
  }

  private fun createPermissionResponse(
    status: PermissionStatus,
    canAskAgain: Boolean = true
  ): PermissionResponse {
    return PermissionResponse(
      canAskAgain = canAskAgain,
      granted = status == PermissionStatus.GRANTED,
      status = status,
      expiresAt = -1.0
    )
  }

  override fun getCameraPermissionStatus(): PermissionStatus {
    return getPermission(android.Manifest.permission.CAMERA)
  }

  override fun getMicrophonePermissionStatus(): PermissionStatus {
    return getPermission(android.Manifest.permission.RECORD_AUDIO)
  }

  private fun requestPermission(permission: String): Promise<PermissionResponse> =
    Promise.async {
      val initial = getPermission(permission)
      if (initial == PermissionStatus.GRANTED) {
        return@async createPermissionResponse(initial, canAskAgain = false)
      }

      val ctx = NitroModules.applicationContext ?: throw Error("NO_CONTEXT")
      val activity = ctx.currentActivity ?: throw Error("NO_ACTIVITY")
      check(activity is PermissionAwareActivity) {
        "Current Activity does not implement PermissionAwareActivity"
      }

      suspendCancellableCoroutine<PermissionResponse> { cont ->
        val reqCode = sharedRequestCode++
        val listener = PermissionListener { code, _, results ->
          if (code != reqCode) return@PermissionListener false
          val raw = results.firstOrNull() ?: PackageManager.PERMISSION_DENIED
          val status = mapToPermissionStatus(raw)
          val canAskAgain =
            status == PermissionStatus.DENIED && canRequestPermission(permission)
          cont.resume(createPermissionResponse(status, canAskAgain))
          true
        }
        activity.requestPermissions(arrayOf(permission), reqCode, listener)
      }
    }

  override fun requestCameraPermission(): Promise<PermissionResponse> {
    return requestPermission(android.Manifest.permission.CAMERA)
  }

  override fun requestMicrophonePermission(): Promise<PermissionResponse> {
    return requestPermission(android.Manifest.permission.RECORD_AUDIO)
  }

  private fun requestGlobalRecordingPermission(): Promise<Pair<Int, Intent>> =
    Promise.async {
      val ctx = NitroModules.applicationContext ?: throw Error("NO_CONTEXT")
      val activity = ctx.currentActivity ?: throw Error("NO_ACTIVITY")
      val intent = mediaProjectionManager.createScreenCaptureIntent()

      suspendCancellableCoroutine<Pair<Int, Intent>> { cont ->
        globalRecordingContinuation = cont
        activity.startActivityForResult(intent, GLOBAL_RECORDING_REQUEST_CODE)
      }
    }

  private var globalRecordingContinuation: kotlin.coroutines.Continuation<Pair<Int, Intent>>? =
    null

  fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    when (requestCode) {
      GLOBAL_RECORDING_REQUEST_CODE -> {
        val continuation = globalRecordingContinuation
        globalRecordingContinuation = null
        if (resultCode == Activity.RESULT_OK && data != null) {
          continuation?.resume(Pair(resultCode, data))
        } else {
          continuation?.resumeWith(
            Result.failure(Exception("Global recording permission denied"))
          )
        }
      }
      else -> {
        Log.w(TAG, "Received unhandled activity result for code: $requestCode")
      }
    }
  }

  // --- In-App Recording No-Op Methods ---

  override fun startInAppRecording(
    enableMic: Boolean,
    enableCamera: Boolean,
    cameraPreviewStyle: RecorderCameraStyle,
    cameraDevice: CameraDevice,
    separateAudioFile: Boolean,
    onRecordingFinished: (ScreenRecordingFile) -> Unit
  ) {
    // no-op
    return
  }

  override fun stopInAppRecording(): Promise<ScreenRecordingFile?> {
    return Promise.async {
      // no-op
      return@async null
    }
  }

  override fun cancelInAppRecording(): Promise<Unit>  {
    return Promise.async {
      // no-op
      return@async
    }
  }

  // --- Global Recording Methods ---

  override fun startGlobalRecording(enableMic: Boolean, separateAudioFile: Boolean, onRecordingError: (RecordingError) -> Unit) {
    if (globalRecordingService?.isCurrentlyRecording() == true) {
      Log.w(TAG, "⚠️ Global recording already in progress")
      return
    }
    val ctx = NitroModules.applicationContext ?: throw Error("NO_CONTEXT")

    // Store the error callback so it can be used by the service
    globalRecordingErrorCallback = onRecordingError

    requestGlobalRecordingPermission().then { (resultCode, resultData) ->
      if (!isServiceBound) {
        val serviceIntent = Intent(ctx, ScreenRecordingService::class.java)
        ctx.bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE)
      }

      val startIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
        action = ScreenRecordingService.ACTION_START_RECORDING
        putExtra(ScreenRecordingService.EXTRA_RESULT_CODE, resultCode)
        putExtra(ScreenRecordingService.EXTRA_RESULT_DATA, resultData)
        putExtra(ScreenRecordingService.EXTRA_ENABLE_MIC, enableMic)
        putExtra(ScreenRecordingService.EXTRA_SEPARATE_AUDIO, separateAudioFile)
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(startIntent)
      } else {
        ctx.startService(startIntent)
      }
    }.catch { error ->
      val recordingError = RecordingError(
        name = "GlobalRecordingStartError",
        message = error.message ?: "Failed to start global recording"
      )
      onRecordingError(recordingError) // Use the callback parameter directly
    }
  }

  override fun stopGlobalRecording(settledTimeMs: Double): Promise<ScreenRecordingFile?> {
    return Promise.async {
      try {
        val ctx = NitroModules.applicationContext
        if (ctx == null) {
          Log.w(TAG, "No application context")
          return@async null
        }

        // Check if we have an active session (MediaProjection exists)
        val service = globalRecordingService
        val hasActiveSession = service?.hasActiveSession() == true
        val serviceRunning = isServiceRunning(ctx)
        
        if (!hasActiveSession && !serviceRunning) {
          Log.w(TAG, "No active recording session to stop")
          return@async null
        }
        
        // If service is running but we're not bound, we still send the stop intent
        // This handles hot reload scenarios where the service is orphaned
        if (serviceRunning) {
          Log.d(TAG, "🛑 Stopping recording service (bound: $isServiceBound, hasSession: $hasActiveSession)")
          
          val stopIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
            action = ScreenRecordingService.ACTION_STOP_RECORDING
          }
          ctx.startService(stopIntent)
        }

        if (isServiceBound) {
          try {
            ctx.unbindService(serviceConnection)
          } catch (e: Exception) {
            Log.w(TAG, "Service already unbound: ${e.message}")
          }
          isServiceBound = false
        }
        
        globalRecordingService = null

        delay(settledTimeMs.toLong())

        return@async retrieveLastGlobalRecording()
      } catch (e: Exception) {
        Log.e(TAG, "Error stopping global recording: ${e.message}")
        e.printStackTrace()
        return@async null
      }
    }
  }

  override fun retrieveLastGlobalRecording(): ScreenRecordingFile? {
    return lastGlobalRecording?.let { file ->
      if (file.exists()) {
        // Build audio file info if available
        val audioFile = lastGlobalAudioRecording?.let { audioFile ->
          if (audioFile.exists()) {
            AudioRecordingFile(
              path = "file://${audioFile.absolutePath}",
              name = audioFile.name,
              size = audioFile.length().toDouble(),
              duration = RecorderUtils.getAudioDuration(audioFile)
            )
          } else {
            null
          }
        }
        
        ScreenRecordingFile(
          path = "file://${file.absolutePath}",
          name = file.name,
          size = file.length().toDouble(),
          duration = RecorderUtils.getVideoDuration(file),
          enabledMicrophone = true, // Assume true for global recordings
          audioFile = audioFile,
          appAudioFile = null  // App audio capture not supported on Android
        )
      } else {
        null
      }
    }
  }

  override fun clearRecordingCache() {
    val ctx = NitroModules.applicationContext ?: return
    // Note: In-app recordings used internal storage. We only clear global now.
    val globalDir = File(ctx.filesDir, "recordings")
    RecorderUtils.clearDirectory(globalDir)
    lastGlobalRecording = null
    lastGlobalAudioRecording = null
  }

  // --- Chunking ---

  override fun markChunkStart() {
    Log.d(TAG, "📍 markChunkStart called")
    globalRecordingService?.markChunkStart() ?: run {
      Log.w(TAG, "⚠️ markChunkStart: Service not bound")
    }
  }

  override fun finalizeChunk(settledTimeMs: Double): Promise<ScreenRecordingFile?> {
    return Promise.async {
      Log.d(TAG, "📦 finalizeChunk called with settledTimeMs=$settledTimeMs")
      
      val service = globalRecordingService
      if (service == null) {
        Log.w(TAG, "⚠️ finalizeChunk: Service not bound")
        return@async null
      }
      
      val chunkFile = service.finalizeChunk()
      
      if (chunkFile == null) {
        Log.w(TAG, "⚠️ finalizeChunk: No chunk file returned")
        return@async null
      }
      
      // Wait for file to settle
      delay(settledTimeMs.toLong())
      
      // Store as last recording for retrieval
      lastGlobalRecording = chunkFile
      
      // Get audio file if extracted
      val audioFile = service.getLastAudioFile()
      lastGlobalAudioRecording = audioFile
      
      // Build audio file info if available
      val audioFileInfo = audioFile?.let { af ->
        if (af.exists()) {
          AudioRecordingFile(
            path = "file://${af.absolutePath}",
            name = af.name,
            size = af.length().toDouble(),
            duration = RecorderUtils.getAudioDuration(af)
          )
        } else {
          null
        }
      }
      
      // Return the chunk file with audio if available
      return@async if (chunkFile.exists()) {
        ScreenRecordingFile(
          path = "file://${chunkFile.absolutePath}",
          name = chunkFile.name,
          size = chunkFile.length().toDouble(),
          duration = RecorderUtils.getVideoDuration(chunkFile),
          enabledMicrophone = service.isMicrophoneEnabled(),
          audioFile = audioFileInfo,
          appAudioFile = null
        )
      } else {
        null
      }
    }
  }

  // --- Extension Status ---

  override fun getExtensionStatus(): RawExtensionStatus {
    val service = globalRecordingService
    return RawExtensionStatus(
      isMicrophoneEnabled = service?.isMicrophoneEnabled() ?: false,
      isCapturingChunk = service?.isCapturingChunk() ?: false,
      chunkStartedAt = service?.getChunkStartedAt() ?: 0.0,
      captureMode = service?.getCaptureMode() ?: CaptureMode.UNKNOWN
    )
  }

  override fun isScreenBeingRecorded(): Boolean {
    val service = globalRecordingService
    val hasSession = service?.hasActiveSession() == true
    val isRecording = service?.isCurrentlyRecording() == true
    val ctx = NitroModules.applicationContext
    val serviceRunning = if (ctx != null) isServiceRunning(ctx) else false
    
    // Log for debugging
    Log.d(TAG, "📊 isScreenBeingRecorded: hasSession=$hasSession, isRecording=$isRecording, serviceRunning=$serviceRunning, isBound=$isServiceBound")
    
    // Return true if we have an active MediaProjection session (even if paused between chunks)
    if (hasSession) {
      return true
    }
    
    // Fallback: check if the service is running even if we're not bound
    if (ctx == null) return false
    
    // If service is running but we're not bound, try to rebind
    if (serviceRunning && !isServiceBound) {
      Log.d(TAG, "📡 Service running but not bound, attempting rebind...")
      rebindToExistingService(ctx)
    }
    
    return serviceRunning
  }
}
