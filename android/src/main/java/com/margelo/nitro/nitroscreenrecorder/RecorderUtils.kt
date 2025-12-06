package com.margelo.nitro.nitroscreenrecorder.utils

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.MediaMetadataRetriever
import android.media.MediaRecorder
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.*

private const val TAG = "RecorderUtils"

/**
 * A data class to hold screen dimension properties.
 */
data class ScreenMetrics(val width: Int, val height: Int, val density: Int)

/**
 * A singleton object containing utility functions for screen recording.
 */
object RecorderUtils {

  /**
   * Initializes and returns the screen metrics (width, height, density).
   */
  fun initializeScreenMetrics(context: Context): ScreenMetrics {
    Log.d(TAG, "📐 Initializing screen metrics...")
    val windowManager =
      context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val displayMetrics = DisplayMetrics()

    val width: Int
    val height: Int
    val density: Int

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val bounds = windowManager.currentWindowMetrics.bounds
      width = bounds.width()
      height = bounds.height()
      density = context.resources.displayMetrics.densityDpi
    } else {
      @Suppress("DEPRECATION")
      windowManager.defaultDisplay.getMetrics(displayMetrics)
      width = displayMetrics.widthPixels
      height = displayMetrics.heightPixels
      density = displayMetrics.densityDpi
    }

    Log.d(TAG, "📐 Screen metrics: ${width}x${height}, density: $density")
    return ScreenMetrics(width, height, density)
  }

  /**
   * Creates a notification channel for the recording service (required for Android O+).
   */
  fun createNotificationChannel(
    context: Context,
    channelId: String,
    channelName: String,
    channelDescription: String
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Log.d(TAG, "🔔 Creating notification channel: $channelId")
      val channel = NotificationChannel(
        channelId,
        channelName,
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = channelDescription
        setSound(null, null)
      }

      val notificationManager =
        context.getSystemService(NotificationManager::class.java)
      notificationManager.createNotificationChannel(channel)
      Log.d(TAG, "✅ Notification channel '$channelId' created")
    }
  }

  /**
   * Creates a new video file in the specified directory.
   */
  fun createOutputFile(directory: File, prefix: String): File {
    Log.d(TAG, "📁 Creating output file with prefix '$prefix'...")
    if (!directory.exists()) {
      Log.d(TAG, "📁 Creating directory: ${directory.absolutePath}")
      directory.mkdirs()
    }

    val timestamp =
      SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
    val fileName = "${prefix}_$timestamp.mp4"
    val file = File(directory, fileName)
    Log.d(TAG, "📁 Created output file: ${file.absolutePath}")
    return file
  }

  /**
   * Creates a new audio file in the specified directory.
   */
  fun createAudioOutputFile(directory: File, prefix: String): File {
    Log.d(TAG, "📁 Creating audio output file with prefix '$prefix'...")
    if (!directory.exists()) {
      Log.d(TAG, "📁 Creating directory: ${directory.absolutePath}")
      directory.mkdirs()
    }

    val timestamp =
      SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
    // Use .m4a extension for extracted audio (AAC in MPEG-4 container)
    val fileName = "${prefix}_$timestamp.m4a"
    val file = File(directory, fileName)
    Log.d(TAG, "📁 Created audio output file: ${file.absolutePath}")
    return file
  }

  /**
  * Retrieves the duration of a video file in **seconds**.
  */
  fun getVideoDuration(file: File): Double {
    if (!file.exists()) return 0.0
    return try {
      val retriever = MediaMetadataRetriever().apply {
        setDataSource(file.absolutePath)
      }
      // extract as ms, convert to Double, divide by 1000
      val seconds = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toDouble()
        ?.div(1_000.0) ?: 0.0
      retriever.release()
      seconds
    } catch (e: Exception) {
      Log.w(TAG, "Could not get video duration: ${e.message}")
      0.0
    }
  }

  /**
   * Configures and returns a MediaRecorder instance.
   */
  fun setupMediaRecorder(
    context: Context,
    enableMicrophone: Boolean,
    outputFile: File,
    screenWidth: Int,
    screenHeight: Int,
    videoBitrate: Int
  ): MediaRecorder {
    Log.d(TAG, "🎬 Setting up MediaRecorder: enableMic=$enableMicrophone")

    val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(context)
    } else {
      @Suppress("DEPRECATION")
      MediaRecorder()
    }

    try {
      recorder.apply {
        setVideoSource(MediaRecorder.VideoSource.SURFACE)
        if (enableMicrophone) {
          setAudioSource(MediaRecorder.AudioSource.MIC)
        }

        setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        setVideoEncoder(MediaRecorder.VideoEncoder.H264)
        if (enableMicrophone) {
          setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        }

        setOutputFile(outputFile.absolutePath)
        setVideoSize(screenWidth, screenHeight)
        setVideoFrameRate(30)
        setVideoEncodingBitRate(videoBitrate) // e.g., 2 * 1024 * 1024 for 2 Mbps

        if (enableMicrophone) {
          setAudioEncodingBitRate(128000)
          setAudioSamplingRate(44100)
        }
      }
      Log.d(TAG, "✅ MediaRecorder setup complete")
    } catch (e: Exception) {
      Log.e(TAG, "❌ Error setting up MediaRecorder: ${e.message}")
      recorder.release()
      throw e
    }

    return recorder
  }

  /**
   * Retrieves the duration of an audio file in **seconds**.
   */
  fun getAudioDuration(file: File): Double {
    if (!file.exists()) return 0.0
    return try {
      val retriever = MediaMetadataRetriever().apply {
        setDataSource(file.absolutePath)
      }
      val seconds = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
        ?.toDouble()
        ?.div(1_000.0) ?: 0.0
      retriever.release()
      seconds
    } catch (e: Exception) {
      Log.w(TAG, "Could not get audio duration: ${e.message}")
      0.0
    }
  }
  
  /**
   * Extracts the audio track from a video file and saves it as a separate M4A file.
   * This allows having audio in both the video AND a separate audio file.
   * 
   * @param videoFile The source video file containing audio
   * @param audioOutputFile The destination file for the extracted audio
   * @return true if extraction was successful, false otherwise
   */
  fun extractAudioFromVideo(videoFile: File, audioOutputFile: File): Boolean {
    if (!videoFile.exists()) {
      Log.e(TAG, "❌ Video file does not exist: ${videoFile.absolutePath}")
      return false
    }
    
    var extractor: android.media.MediaExtractor? = null
    var muxer: android.media.MediaMuxer? = null
    
    try {
      Log.d(TAG, "🎵 Extracting audio from video: ${videoFile.name}")
      
      extractor = android.media.MediaExtractor()
      extractor.setDataSource(videoFile.absolutePath)
      
      // Find the audio track
      var audioTrackIndex = -1
      var audioFormat: android.media.MediaFormat? = null
      
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(android.media.MediaFormat.KEY_MIME)
        if (mime?.startsWith("audio/") == true) {
          audioTrackIndex = i
          audioFormat = format
          break
        }
      }
      
      if (audioTrackIndex == -1 || audioFormat == null) {
        Log.w(TAG, "⚠️ No audio track found in video file")
        return false
      }
      
      Log.d(TAG, "📍 Found audio track at index $audioTrackIndex")
      
      // Select the audio track
      extractor.selectTrack(audioTrackIndex)
      
      // Create muxer for output
      muxer = android.media.MediaMuxer(
        audioOutputFile.absolutePath,
        android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4
      )
      
      val outputTrackIndex = muxer.addTrack(audioFormat)
      muxer.start()
      
      // Allocate buffer for reading samples
      val maxBufferSize = audioFormat.getInteger(android.media.MediaFormat.KEY_MAX_INPUT_SIZE, 1024 * 1024)
      val buffer = java.nio.ByteBuffer.allocate(maxBufferSize)
      val bufferInfo = android.media.MediaCodec.BufferInfo()
      
      // Copy all audio samples
      while (true) {
        val sampleSize = extractor.readSampleData(buffer, 0)
        if (sampleSize < 0) {
          break
        }
        
        bufferInfo.offset = 0
        bufferInfo.size = sampleSize
        bufferInfo.presentationTimeUs = extractor.sampleTime
        bufferInfo.flags = extractor.sampleFlags
        
        muxer.writeSampleData(outputTrackIndex, buffer, bufferInfo)
        extractor.advance()
      }
      
      Log.d(TAG, "✅ Audio extraction complete: ${audioOutputFile.name}")
      return true
      
    } catch (e: Exception) {
      Log.e(TAG, "❌ Error extracting audio: ${e.message}")
      e.printStackTrace()
      // Clean up failed output file
      audioOutputFile.delete()
      return false
    } finally {
      try {
        muxer?.stop()
        muxer?.release()
      } catch (e: Exception) {
        Log.w(TAG, "Warning during muxer cleanup: ${e.message}")
      }
      extractor?.release()
    }
  }

  /**
   * Deletes all .mp4 and .m4a files in a given directory.
   */
  fun clearDirectory(directory: File) {
    Log.d(TAG, "🧹 Clearing directory: ${directory.absolutePath}")
    if (directory.exists() && directory.isDirectory) {
      directory.listFiles()?.forEach { file ->
        if (file.isFile && (file.name.endsWith(".mp4") || file.name.endsWith(".m4a"))) {
          if (file.delete()) {
            Log.d(TAG, "🗑️ Deleted file: ${file.name}")
          } else {
            Log.w(TAG, "⚠️ Failed to delete file: ${file.name}")
          }
        }
      }
    } else {
      Log.d(TAG, "ℹ️ Directory does not exist, nothing to clear.")
    }
  }

  /**
   * Optimizes an MP4 file for streaming by moving the moov atom to the beginning.
   * This enables progressive playback and faster video startup.
   *
   * Uses embedded QtFastStart implementation for efficient moov atom relocation.
   */
  fun optimizeForStreaming(inputFile: File): File {
    if (!inputFile.exists()) {
      Log.e(TAG, "❌ Input file does not exist: ${inputFile.absolutePath}")
      return inputFile
    }

    val tempFile = File(inputFile.parent, "${inputFile.nameWithoutExtension}_optimized.mp4")

    try {
      Log.d(TAG, "🎬 Optimizing MP4 for streaming: ${inputFile.name}")

      FileInputStream(inputFile).use { fis ->
        FileOutputStream(tempFile).use { fos ->
          val success = com.margelo.nitro.nitroscreenrecorder.QtFastStart.fastStart(fis.channel, fos.channel)

          if (success) {
            Log.d(TAG, "✅ Moov atom successfully moved to beginning")
          } else {
            Log.i(TAG, "ℹ️ Moov atom already at beginning, no optimization needed")
            // File is already optimized, clean up temp file and return original
            tempFile.delete()
            return inputFile
          }
        }
      }

      // Replace original with optimized version
      if (inputFile.delete()) {
        if (tempFile.renameTo(inputFile)) {
          Log.d(TAG, "✅ MP4 optimization complete: ${inputFile.absolutePath}")
          return inputFile
        } else {
          Log.e(TAG, "❌ Failed to rename optimized file")
          tempFile.delete()
          return inputFile
        }
      } else {
        Log.e(TAG, "❌ Failed to delete original file")
        tempFile.delete()
        return inputFile
      }

    } catch (e: com.margelo.nitro.nitroscreenrecorder.QtFastStart.QtFastStartException) {
      Log.e(TAG, "❌ QtFastStart error: ${e.message}", e)
      tempFile.delete()
      return inputFile
    } catch (e: Exception) {
      Log.e(TAG, "❌ Failed to optimize MP4 for streaming: ${e.message}", e)
      tempFile.delete()
      return inputFile
    }
  }
}
