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
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlinx.coroutines.withTimeoutOrNull

data class Listener<T>(val id: Double, val callback: T)

@DoNotStrip
class NitroScreenRecorder : HybridNitroScreenRecorderSpec() {

  private lateinit var mediaProjectionManager: MediaProjectionManager

  // Global recording properties
  private var globalRecordingService: ScreenRecordingService? = null
  private var isServiceBound = false
  private var lastGlobalRecording: File? = null
  private var globalRecordingErrorCallback: ((RecordingError) -> Unit)? = null
  @Volatile
  private var isConsentRequestInFlight = false

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
      event: ScreenRecordingEvent,
      enabledMic: Boolean
    ) {
      Log.d(TAG, "🏁 notifyGlobalRecordingFinished called with file: ${file.absolutePath}")
      instance?.let { recorder ->
        recorder.lastGlobalRecording = file
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
      Log.d(TAG, "✅ NitroScreenRecorder initialization complete")
    } ?: run {
      Log.e(TAG, "❌ NitroScreenRecorder: applicationContext was null")
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

  private fun getAuthoritativeSessionState(): ServiceState {
    return ScreenRecordingService.getSessionStateSnapshot()
  }

  private fun hasScreenRecordingSession(): Boolean {
    return getAuthoritativeSessionState() != ServiceState.IDLE
  }

  private fun toSessionState(state: ServiceState): ScreenRecordingSessionState {
    return when (state) {
      ServiceState.IDLE -> ScreenRecordingSessionState.IDLE
      ServiceState.PREPARED -> ScreenRecordingSessionState.PREPARED
      ServiceState.RECORDING -> ScreenRecordingSessionState.RECORDING
    }
  }

  private suspend fun awaitSessionState(
    timeoutMs: Long,
    predicate: (ServiceState) -> Boolean
  ): ServiceState? {
    val currentState = getAuthoritativeSessionState()
    if (predicate(currentState)) {
      return currentState
    }

    return withTimeoutOrNull(timeoutMs) {
      suspendCancellableCoroutine<ServiceState> { cont ->
        var removeListener: (() -> Unit)? = null

        fun complete(state: ServiceState) {
          if (predicate(state) && cont.isActive) {
            removeListener?.invoke()
            cont.resume(state)
          }
        }

        removeListener = ScreenRecordingService.addSessionStateListener { state ->
          complete(state)
        }

        cont.invokeOnCancellation {
          removeListener?.invoke()
        }

        val latestState = getAuthoritativeSessionState()
        complete(latestState)
      }
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

  private suspend fun awaitScreenCaptureConsent(): Pair<Int, Intent> {
    val ctx = NitroModules.applicationContext ?: throw Error("NO_CONTEXT")
    val activity = ctx.currentActivity ?: throw Error("NO_ACTIVITY")
    val intent = mediaProjectionManager.createScreenCaptureIntent()

    return suspendCancellableCoroutine<Pair<Int, Intent>> { cont ->
      globalRecordingContinuation = cont
      activity.startActivityForResult(intent, GLOBAL_RECORDING_REQUEST_CODE)
    }
  }

  private fun requestGlobalRecordingPermission(): Promise<Pair<Int, Intent>> =
    Promise.async { awaitScreenCaptureConsent() }

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

  override fun requestScreenRecordingConsent(): Promise<Boolean> = Promise.async {
    val ctx = NitroModules.applicationContext ?: throw Error("NO_CONTEXT")

    when (getAuthoritativeSessionState()) {
      ServiceState.PREPARED,
      ServiceState.RECORDING -> return@async true
      ServiceState.IDLE -> Unit
    }

    if (isConsentRequestInFlight) {
      return@async awaitSessionState(timeoutMs = 5_000) {
        it != ServiceState.IDLE
      } != null
    }

    isConsentRequestInFlight = true
    var didBindService = false

    try {
      if (!isServiceBound) {
        val serviceIntent = Intent(ctx, ScreenRecordingService::class.java)
        didBindService =
          ctx.bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE)
      }

      val (resultCode, resultData) = awaitScreenCaptureConsent()

      val prepareIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
        action = ScreenRecordingService.ACTION_PREPARE
        putExtra(ScreenRecordingService.EXTRA_RESULT_CODE, resultCode)
        putExtra(ScreenRecordingService.EXTRA_RESULT_DATA, resultData)
      }

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        ctx.startForegroundService(prepareIntent)
      } else {
        ctx.startService(prepareIntent)
      }

      val hasActiveSession = awaitSessionState(timeoutMs = 5_000) {
        it != ServiceState.IDLE
      } != null
      if (!hasActiveSession) {
        Log.w(TAG, "Timed out waiting for screen recording session to become active")
      }

      hasActiveSession
    } finally {
      if (!hasScreenRecordingSession() && (isServiceBound || didBindService)) {
        try {
          ctx.unbindService(serviceConnection)
        } catch (error: IllegalArgumentException) {
          Log.w(TAG, "Screen recording consent service was already unbound")
        }
        globalRecordingService = null
        isServiceBound = false
      }
      isConsentRequestInFlight = false
    }
  }

  override fun releaseScreenRecordingConsent() {
    val ctx = NitroModules.applicationContext ?: return

    if (getAuthoritativeSessionState() != ServiceState.PREPARED) {
      return
    }

    val releaseIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
      action = ScreenRecordingService.ACTION_RELEASE
    }
    ctx.startService(releaseIntent)

    if (isServiceBound) {
      ctx.unbindService(serviceConnection)
      globalRecordingService = null
      isServiceBound = false
    }
  }

  override fun isScreenRecordingConsentGranted(): Boolean {
    return hasScreenRecordingSession()
  }

  override fun getScreenRecordingSessionState(): ScreenRecordingSessionState {
    return toSessionState(getAuthoritativeSessionState())
  }

  // --- In-App Recording No-Op Methods ---

  override fun startInAppRecording(
    enableMic: Boolean,
    enableCamera: Boolean,
    cameraPreviewStyle: RecorderCameraStyle,
    cameraDevice: CameraDevice,
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

  override fun startGlobalRecording(
    enableMic: Boolean,
    usePreparedConsent: Boolean,
    onRecordingError: (RecordingError) -> Unit
  ) {
    if (getAuthoritativeSessionState() == ServiceState.RECORDING) {
      Log.w(TAG, "⚠️ Global recording already in progress")
      return
    }
    val ctx = NitroModules.applicationContext ?: throw Error("NO_CONTEXT")

    // Store the error callback so it can be used by the service
    globalRecordingErrorCallback = onRecordingError

    if (usePreparedConsent) {
      if (getAuthoritativeSessionState() != ServiceState.PREPARED) {
        onRecordingError(
          RecordingError(
            name = "PreparedConsentNotAvailable",
            message = "Call requestScreenRecordingConsent() before starting with usePreparedConsent."
          )
        )
        return
      }

      val startIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
        action = ScreenRecordingService.ACTION_START_RECORDING
        putExtra(ScreenRecordingService.EXTRA_ENABLE_MIC, enableMic)
        putExtra(ScreenRecordingService.EXTRA_USE_PREPARED_CONSENT, true)
      }
      ctx.startService(startIntent)
      return
    }

    requestGlobalRecordingPermission().then { (resultCode, resultData) ->
      if (!isServiceBound) {
        val serviceIntent = Intent(ctx, ScreenRecordingService::class.java)
        ctx.bindService(serviceIntent, serviceConnection, Context.BIND_AUTO_CREATE)
      }

      val startIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
        action = ScreenRecordingService.ACTION_START_RECORDING
        putExtra(ScreenRecordingService.EXTRA_RESULT_CODE, resultCode)
        putExtra(ScreenRecordingService.EXTRA_RESULT_DATA, resultData)
        putExtra(ScreenRecordingService.EXTRA_ENABLE_MIC, enableMic) // Use the parameter instead of hardcoded true
        putExtra(ScreenRecordingService.EXTRA_USE_PREPARED_CONSENT, false)
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
      val ctx = NitroModules.applicationContext ?: return@async null

      if (getAuthoritativeSessionState() != ServiceState.RECORDING) {
        Log.w(TAG, "No active recording to stop")
        return@async null
      }

      val stopIntent = Intent(ctx, ScreenRecordingService::class.java).apply {
        action = ScreenRecordingService.ACTION_STOP_RECORDING
      }
      ctx.startService(stopIntent)

      if (isServiceBound) {
        ctx.unbindService(serviceConnection)
        globalRecordingService = null
        isServiceBound = false
      }

      delay(settledTimeMs.toLong())

      return@async retrieveLastGlobalRecording()
    }
  }

  override fun retrieveLastGlobalRecording(): ScreenRecordingFile? {
    return lastGlobalRecording?.let { file ->
      if (file.exists()) {
        ScreenRecordingFile(
          path = "file://${file.absolutePath}",
          name = file.name,
          size = file.length().toDouble(),
          duration = RecorderUtils.getVideoDuration(file),
          enabledMicrophone = true // Assume true for global recordings
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
  }
}
