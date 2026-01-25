import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  Platform,
  TouchableOpacity,
  Alert,
} from 'react-native';
import * as ScreenRecorder from '../../';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState, useCallback, useEffect, useRef } from 'react';

const MIC_FAILURE_DELAY_MS = 1500; // Wait 1.5s before marking mic failure

/**
 * Dev-only hook to cleanup stale Android recording sessions after hot reload.
 * In production, this is a no-op since hot reload doesn't exist.
 */
const useDevCleanup = () => {
  useEffect(() => {
    if (__DEV__ && Platform.OS === 'android') {
      console.log('🧹 [Dev] Cleaning up any stale recording sessions...');
      ScreenRecorder.stopGlobalRecording({ settledTimeMs: 100 })
        .then(() => {
          console.log('🧹 [Dev] Cleanup complete (session was active)');
        })
        .catch(() => {
          console.log('🧹 [Dev] Cleanup complete (no active session)');
        });
    }
  }, []);
};

type Chunk = {
  id: number;
  file: ScreenRecorder.ScreenRecordingFile;
  timestamp: Date;
};

export default function App() {
  // Dev-only: cleanup stale sessions after hot reload (Android)
  useDevCleanup();

  // In-app recording state
  const [inAppRecording, setInAppRecording] = useState<
    ScreenRecorder.ScreenRecordingFile | undefined
  >();

  // Global recording state
  const [globalRecording, setGlobalRecording] = useState<
    ScreenRecorder.ScreenRecordingFile | undefined
  >();

  // Chunking state
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [chunkCounter, setChunkCounter] = useState(0);
  const [isChunkingActive, setIsChunkingActive] = useState(false);
  const [selectedChunk, setSelectedChunk] = useState<Chunk | undefined>();

  // Mic detection gating state
  const [hadMicFailure, setHadMicFailure] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const micFailureTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const hasStoppedForMicFailureRef = useRef(false);

  // Use the hook - it handles extension status polling while recording
  const { isRecording, extensionStatus } = ScreenRecorder.useGlobalRecording({
    onRecordingStarted: () => {
      console.log('🎬 Recording started');
      hasStoppedForMicFailureRef.current = false;
      setHadMicFailure(false);
    },
    onRecordingFinished: () => {
      console.log('🛑 Recording ended');
      setIsChunkingActive(false);
      hasStoppedForMicFailureRef.current = false;
    },
    onBroadcastModalShown: () => {
      console.log('📱 Modal showing');
    },
    onBroadcastModalDismissed: () => {
      console.log('📱 Modal dismissed');
    },
  });

  // Mic detection gating logic
  const isMicEnabled =
    Platform.OS === 'android'
      ? isRecording
      : extensionStatus.isMicrophoneEnabled;

  const isReady = isRecording && isMicEnabled;

  // Extension is actually running (not just starting)
  const extensionRunning =
    extensionStatus.state === 'running' ||
    extensionStatus.state === 'capturingChunk';
  const currentMicFailure = isRecording && extensionRunning && !isMicEnabled;

  // Detect mic failure with delay to avoid false positives
  useEffect(() => {
    if (currentMicFailure && !hadMicFailure) {
      if (micFailureTimeoutRef.current) {
        clearTimeout(micFailureTimeoutRef.current);
      }

      micFailureTimeoutRef.current = setTimeout(() => {
        console.log(
          '⚠️ Mic failure detected - recording started without microphone enabled'
        );
        setHadMicFailure(true);
        micFailureTimeoutRef.current = null;
      }, MIC_FAILURE_DELAY_MS);
    } else if (!currentMicFailure && micFailureTimeoutRef.current) {
      clearTimeout(micFailureTimeoutRef.current);
      micFailureTimeoutRef.current = null;
    }

    return () => {
      if (micFailureTimeoutRef.current) {
        clearTimeout(micFailureTimeoutRef.current);
        micFailureTimeoutRef.current = null;
      }
    };
  }, [currentMicFailure, hadMicFailure]);

  // Log when recording becomes ready (mic enabled)
  const wasReadyRef = useRef(false);
  useEffect(() => {
    if (isReady && !wasReadyRef.current) {
      console.log('✅ Recording ready with mic enabled');
      wasReadyRef.current = true;
    } else if (!isRecording && wasReadyRef.current) {
      wasReadyRef.current = false; // Reset when recording stops
    }
  }, [isReady, isRecording]);

  // Clear mic failure when recording becomes ready
  useEffect(() => {
    if (isReady && hadMicFailure) {
      console.log('✅ Mic now enabled, clearing failure state');
      setHadMicFailure(false);
    }
  }, [isReady, hadMicFailure]);

  // Auto-stop recording on mic failure
  useEffect(() => {
    if (
      hadMicFailure &&
      isRecording &&
      !isStopping &&
      !hasStoppedForMicFailureRef.current
    ) {
      console.log('🛑 Auto-stopping recording due to mic not enabled');
      hasStoppedForMicFailureRef.current = true;
      setIsStopping(true);
      ScreenRecorder.stopGlobalRecording({ settledTimeMs: 500 })
        .then(() => {
          console.log('✅ Recording stopped after mic failure');
          setIsStopping(false);
        })
        .catch((error) => {
          console.error(
            '❌ Failed to stop recording after mic failure:',
            error
          );
          setIsStopping(false);
        });
    }
  }, [hadMicFailure, isRecording, isStopping]);

  // Clear stopping state when recording ends
  useEffect(() => {
    if (!isRecording && isStopping) {
      setIsStopping(false);
    }
  }, [isRecording, isStopping]);

  // Video players
  const inAppPlayer = useVideoPlayer(inAppRecording?.path ?? null);
  const globalPlayer = useVideoPlayer(globalRecording?.path ?? null);
  const chunkPlayer = useVideoPlayer(selectedChunk?.file.path ?? null);

  // Permission Functions
  const requestPermissions = async () => {
    const mic = await ScreenRecorder.requestMicrophonePermission();
    console.log('Mic permission:', mic.status);
    if (Platform.OS === 'ios') {
      const cam = await ScreenRecorder.requestCameraPermission();
      console.log('Camera permission:', cam.status);
    }
    Alert.alert('Permissions Requested', 'Check console for status');
  };

  // In-App Recording Functions
  const handleStartInAppRecording = async () => {
    try {
      await ScreenRecorder.startInAppRecording({
        options: {
          enableMic: true,
          enableCamera: false,
        },
        onRecordingFinished(file) {
          console.log('✅ In-app recording finished:', file.name);
          setInAppRecording(file);
        },
      });
    } catch (error) {
      console.error('❌ Error starting in-app recording:', error);
      Alert.alert('Error', String(error));
    }
  };

  const handleStopInAppRecording = async () => {
    const file = await ScreenRecorder.stopInAppRecording();
    if (file) {
      setInAppRecording(file);
    }
  };

  // Global Recording Functions
  const handleStartGlobalRecording = () => {
    // Reset chunking state when starting new recording
    setChunks([]);
    setChunkCounter(0);
    setIsChunkingActive(false);
    setSelectedChunk(undefined);

    ScreenRecorder.startGlobalRecording({
      options: {
        enableMic: true,
        separateAudioFile: true,
      },
      onRecordingError: (error) => {
        console.error('❌ Global recording error:', error);
        Alert.alert('Recording Error', error.message);
      },
    });
  };

  const handleStopGlobalRecording = async () => {
    const file = await ScreenRecorder.stopGlobalRecording();
    if (file) {
      setGlobalRecording(file);
      console.log('✅ Global recording stopped:');
      console.log(`   📹 Video: ${file.path}`);
      console.log(`   📹 Name: ${file.name}`);
      console.log(`   📹 Size: ${(file.size / 1024).toFixed(1)} KB`);
      console.log(`   📹 Duration: ${file.duration.toFixed(1)}s`);
      if (file.audioFile) {
        console.log(`   🎵 Audio: ${file.audioFile.path}`);
        console.log(`   🎵 Audio Name: ${file.audioFile.name}`);
        console.log(
          `   🎵 Audio Size: ${(file.audioFile.size / 1024).toFixed(1)} KB`
        );
        console.log(
          `   🎵 Audio Duration: ${file.audioFile.duration.toFixed(1)}s`
        );
      } else {
        console.log(`   🎵 Audio: (none)`);
      }
    }
    setIsChunkingActive(false);
  };

  // Chunking Functions
  const handleMarkChunkStart = useCallback(() => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    ScreenRecorder.markChunkStart();
    setIsChunkingActive(true);
    console.log('📍 Chunk start marked');
    Alert.alert('Chunk Started', 'Recording content from this point...');
  }, [isRecording]);

  const handleFinalizeChunk = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    if (!isChunkingActive) {
      Alert.alert('No Active Chunk', 'Call markChunkStart() first');
      return;
    }

    console.log('📦 Finalizing chunk...');
    const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 1000 });

    if (file) {
      const newChunk: Chunk = {
        id: chunkCounter + 1,
        file,
        timestamp: new Date(),
      };
      setChunks((prev) => [...prev, newChunk]);
      setChunkCounter((prev) => prev + 1);
      setSelectedChunk(newChunk);

      // Log all file paths
      console.log(`✅ Chunk ${newChunk.id} finalized:`);
      console.log(`   📹 Video: ${file.path}`);
      console.log(`   📹 Name: ${file.name}`);
      console.log(`   📹 Size: ${(file.size / 1024).toFixed(1)} KB`);
      console.log(`   📹 Duration: ${file.duration.toFixed(1)}s`);
      if (file.audioFile) {
        console.log(`   🎵 Audio: ${file.audioFile.path}`);
        console.log(`   🎵 Audio Name: ${file.audioFile.name}`);
        console.log(
          `   🎵 Audio Size: ${(file.audioFile.size / 1024).toFixed(1)} KB`
        );
        console.log(
          `   🎵 Audio Duration: ${file.audioFile.duration.toFixed(1)}s`
        );
      } else {
        console.log(`   🎵 Audio: (none)`);
      }

      Alert.alert(
        'Chunk Finalized',
        `Chunk ${newChunk.id} saved (${(file.size / 1024).toFixed(1)} KB, ${file.duration.toFixed(1)}s)${file.audioFile ? '\n🎵 Audio extracted' : ''}`
      );
    } else {
      console.log('⚠️ No chunk file returned');
      Alert.alert('Error', 'Failed to get chunk file');
    }
  }, [isRecording, isChunkingActive, chunkCounter]);

  const handleClearChunks = () => {
    setChunks([]);
    setChunkCounter(0);
    setSelectedChunk(undefined);
    ScreenRecorder.clearCache();
    console.log('🗑️ Chunks cleared');
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Screen Recorder Demo</Text>
        <Text style={styles.headerSubtitle}>
          {isRecording ? '🔴 Recording Active' : '⚪ Not Recording'}
        </Text>
      </View>

      {/* Permissions Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Setup</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermissions}>
          <Text style={styles.buttonText}>Request Permissions</Text>
        </TouchableOpacity>
      </View>

      {/* Chunking Section - Main Feature */}
      <View style={[styles.section, styles.chunkingSection]}>
        <Text style={styles.sectionTitle}>🎯 Chunk Recording (New!)</Text>
        <Text style={styles.description}>
          Start a global recording, then mark chunk boundaries to capture
          segments for progressive upload.
        </Text>

        {/* Recording Controls */}
        <View style={styles.buttonRow}>
          {!isRecording ? (
            <TouchableOpacity
              style={[styles.button, styles.startButton]}
              onPress={handleStartGlobalRecording}
            >
              <Text style={styles.buttonText}>▶ Start Recording</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.button, styles.stopButton]}
              onPress={handleStopGlobalRecording}
            >
              <Text style={styles.buttonText}>⏹ Stop Recording</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Chunk Controls */}
        <View style={styles.chunkControls}>
          <TouchableOpacity
            style={[
              styles.chunkButton,
              styles.markButton,
              !isRecording && styles.disabledButton,
            ]}
            onPress={handleMarkChunkStart}
            disabled={!isRecording}
          >
            <Text style={styles.chunkButtonText}>📍 Mark Start</Text>
            <Text style={styles.chunkButtonSubtext}>Begin new chunk</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.chunkButton,
              styles.finalizeButton,
              (!isRecording || !isChunkingActive) && styles.disabledButton,
            ]}
            onPress={handleFinalizeChunk}
            disabled={!isRecording || !isChunkingActive}
          >
            <Text style={styles.chunkButtonText}>📦 Finalize</Text>
            <Text style={styles.chunkButtonSubtext}>Save & get file</Text>
          </TouchableOpacity>
        </View>

        {/* Mic Gating Status Banner */}
        {isRecording && (
          <View
            style={[
              styles.micStatusBanner,
              isReady && styles.micStatusReady,
              hadMicFailure && styles.micStatusFailure,
              isStopping && styles.micStatusStopping,
              !isReady &&
                !hadMicFailure &&
                !isStopping &&
                styles.micStatusAwaiting,
            ]}
          >
            <Text style={styles.micStatusText}>
              {isStopping
                ? '🛑 Stopping (mic not enabled)...'
                : hadMicFailure
                  ? '❌ MIC FAILURE - Auto-stopping recording'
                  : isReady
                    ? '✅ Recording with Mic Enabled'
                    : '⏳ Awaiting mic activation...'}
            </Text>
          </View>
        )}

        {/* Status */}
        <View style={styles.statusBar}>
          <View style={styles.statusRow}>
            <Text style={styles.statusText}>
              Extension:{' '}
              {extensionStatus.state === 'running' ||
              extensionStatus.state === 'capturingChunk'
                ? '🟢 Recording'
                : '⚪ Idle'}
            </Text>
            <Text style={styles.statusText}>
              Mic: {isMicEnabled ? '🎤 Enabled' : '🔇 Disabled'}
            </Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusText}>
              Chunk:{' '}
              {extensionStatus.isCapturingChunk
                ? `🔴 ${Math.floor(Date.now() / 1000 - extensionStatus.chunkStartedAt)}s`
                : '⚪ None'}
            </Text>
            <Text style={styles.statusText}>Total: {chunks.length}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusText}>
              Gating:{' '}
              {hadMicFailure
                ? '❌ Failed'
                : isReady
                  ? '✅ Ready'
                  : isRecording
                    ? '⏳ Checking...'
                    : '⚪ Idle'}
            </Text>
            <Text style={styles.statusText}>
              isReady: {isReady ? 'true' : 'false'}
            </Text>
          </View>
          {/* Capture Mode - Android 14+ only */}
          {Platform.OS === 'android' && isRecording && (
            <View style={styles.statusRow}>
              <Text style={styles.statusText}>
                Capture Mode:{' '}
                {extensionStatus.captureMode === 'entireScreen'
                  ? '📺 Entire Screen'
                  : extensionStatus.captureMode === 'singleApp'
                    ? '📱 Single App'
                    : '❓ Unknown'}
              </Text>
            </View>
          )}
        </View>

        {/* Chunks List */}
        {chunks.length > 0 && (
          <View style={styles.chunksList}>
            <Text style={styles.chunksTitle}>Captured Chunks:</Text>
            {chunks.map((chunk) => (
              <TouchableOpacity
                key={chunk.id}
                style={[
                  styles.chunkItem,
                  selectedChunk?.id === chunk.id && styles.selectedChunkItem,
                ]}
                onPress={() => setSelectedChunk(chunk)}
              >
                <View style={styles.chunkInfo}>
                  <Text style={styles.chunkName}>Chunk {chunk.id}</Text>
                  <Text style={styles.chunkMeta}>
                    {formatDuration(chunk.file.duration)} •{' '}
                    {formatSize(chunk.file.size)}
                  </Text>
                </View>
                <Text style={styles.chunkTime}>
                  {chunk.timestamp.toLocaleTimeString()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Chunk Player */}
        {selectedChunk && (
          <View style={styles.playerContainer}>
            <Text style={styles.playerLabel}>
              Playing: Chunk {selectedChunk.id}
            </Text>
            <VideoView
              player={chunkPlayer}
              style={styles.player}
              contentFit="contain"
            />
          </View>
        )}

        {/* Clear Chunks */}
        {chunks.length > 0 && (
          <TouchableOpacity
            style={[styles.button, styles.clearButton]}
            onPress={handleClearChunks}
          >
            <Text style={styles.buttonText}>🗑 Clear All Chunks</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* In-App Recording Section */}
      {Platform.OS === 'ios' && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>In-App Recording</Text>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.button, styles.startButton, { flex: 1 }]}
              onPress={handleStartInAppRecording}
            >
              <Text style={styles.buttonText}>Start</Text>
            </TouchableOpacity>
            <View style={{ width: 8 }} />
            <TouchableOpacity
              style={[styles.button, styles.stopButton, { flex: 1 }]}
              onPress={handleStopInAppRecording}
            >
              <Text style={styles.buttonText}>Stop</Text>
            </TouchableOpacity>
          </View>
          {inAppRecording && (
            <View style={styles.playerContainer}>
              <Text style={styles.playerLabel}>
                {inAppRecording.name} ({formatSize(inAppRecording.size)})
              </Text>
              <VideoView
                player={inAppPlayer}
                style={styles.player}
                contentFit="contain"
              />
            </View>
          )}
        </View>
      )}

      {/* Global Recording Player */}
      {globalRecording && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Last Global Recording</Text>
          <Text style={styles.playerLabel}>
            {globalRecording.name} • {formatDuration(globalRecording.duration)}{' '}
            • {formatSize(globalRecording.size)}
          </Text>
          <VideoView
            player={globalPlayer}
            style={styles.player}
            contentFit="contain"
          />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  contentContainer: {
    paddingTop: 60,
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  headerSubtitle: {
    fontSize: 16,
    color: '#8E8E93',
    marginTop: 4,
  },
  section: {
    backgroundColor: '#1C1C1E',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  chunkingSection: {
    borderWidth: 1,
    borderColor: '#3A3A3C',
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  description: {
    fontSize: 14,
    color: '#8E8E93',
    marginBottom: 16,
    lineHeight: 20,
  },
  button: {
    backgroundColor: '#2C2C2E',
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  startButton: {
    backgroundColor: '#34C759',
  },
  stopButton: {
    backgroundColor: '#FF3B30',
  },
  clearButton: {
    backgroundColor: '#48484A',
    marginTop: 16,
  },
  disabledButton: {
    opacity: 0.4,
  },
  chunkControls: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  chunkButton: {
    flex: 1,
    paddingVertical: 20,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  markButton: {
    backgroundColor: '#5856D6',
  },
  finalizeButton: {
    backgroundColor: '#FF9500',
  },
  chunkButtonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
  chunkButtonSubtext: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 4,
  },
  micStatusBanner: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
    alignItems: 'center',
  },
  micStatusReady: {
    backgroundColor: '#1B4332',
    borderWidth: 1,
    borderColor: '#34C759',
  },
  micStatusFailure: {
    backgroundColor: '#4A1C1C',
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  micStatusStopping: {
    backgroundColor: '#4A3A1C',
    borderWidth: 1,
    borderColor: '#FF9500',
  },
  micStatusAwaiting: {
    backgroundColor: '#1C2A4A',
    borderWidth: 1,
    borderColor: '#5856D6',
  },
  micStatusText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  statusBar: {
    backgroundColor: '#2C2C2E',
    padding: 12,
    borderRadius: 8,
    marginBottom: 16,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 13,
  },
  chunksList: {
    marginTop: 8,
  },
  chunksTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8E8E93',
    marginBottom: 8,
  },
  chunkItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#2C2C2E',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  selectedChunkItem: {
    backgroundColor: '#3A3A3C',
    borderWidth: 1,
    borderColor: '#5856D6',
  },
  chunkInfo: {
    flex: 1,
  },
  chunkName: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '500',
  },
  chunkMeta: {
    color: '#8E8E93',
    fontSize: 12,
    marginTop: 2,
  },
  chunkTime: {
    color: '#8E8E93',
    fontSize: 12,
  },
  playerContainer: {
    marginTop: 12,
  },
  playerLabel: {
    fontSize: 12,
    color: '#8E8E93',
    marginBottom: 8,
  },
  player: {
    backgroundColor: '#000000',
    height: 200,
    width: '100%',
    borderRadius: 12,
  },
});
