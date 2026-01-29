import {
  View,
  StyleSheet,
  Text,
  ScrollView,
  Platform,
  TouchableOpacity,
  Alert,
  Animated,
  Dimensions,
  Easing,
} from 'react-native';
import * as ScreenRecorder from '../../';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';

const MIC_FAILURE_DELAY_MS = 1500; // Wait 1.5s before marking mic failure
const THERMAL_STRESS_CHUNK_MS = 150;
const THERMAL_STRESS_PAUSE_MS = 1;
const GPU_LAYER_COUNT = 28;
const GPU_LAYER_MIN_SIZE = 80;
const GPU_LAYER_MAX_SIZE = 200;
const GPU_LAYER_OPACITY_MIN = 0.08;
const GPU_LAYER_OPACITY_MAX = 0.35;
const GPU_OVERLAY_OPACITY = 0.35;
const GPU_ANIMATION_DURATION_MS = 5000;
const NETWORK_STRESS_URL = 'https://speed.cloudflare.com/__down?bytes=8000000';
const NETWORK_STRESS_CONCURRENCY = 2;
const NETWORK_STRESS_PAUSE_MS = 200;
const MEMORY_STRESS_CHUNK_MB = 12;
const MEMORY_STRESS_MAX_BUFFERS = 6;
const MEMORY_STRESS_INTERVAL_MS = 500;

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

  const formatAudioMetrics = useCallback((metricsJson: string) => {
    try {
      const parsed = JSON.parse(metricsJson);
      return {
        formatted: JSON.stringify(parsed, null, 2),
        parsed,
      };
    } catch (error) {
      console.warn('Failed to parse audio metrics JSON', error);
      return {
        formatted: metricsJson,
        parsed: undefined,
      };
    }
  }, []);

  const logAudioMetricsToConsole = useCallback(
    (context?: string) => {
      if (Platform.OS !== 'ios') {
        return;
      }
      const metricsJson = ScreenRecorder.getExtensionAudioMetrics();
      const { parsed } = formatAudioMetrics(metricsJson);
      const metricsArray = parsed?.metrics;
      const latestMetrics =
        Array.isArray(metricsArray) && metricsArray.length > 0
          ? metricsArray[metricsArray.length - 1]
          : (parsed ?? metricsJson);
      const label = context
        ? `📊 Extension audio metrics (${context})`
        : '📊 Extension audio metrics';
      console.log(label, latestMetrics);
    },
    [formatAudioMetrics]
  );

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
    const t0 = performance.now();
    const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 1000 });
    console.log(
      `📦 finalizeChunk took ${(performance.now() - t0).toFixed(0)}ms`
    );
    logAudioMetricsToConsole('finalize chunk');

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
      // Dump extension logs on failure for debugging
      if (Platform.OS === 'ios') {
        console.log('📜 Extension logs (last 15 entries):');
        const logs = ScreenRecorder.getExtensionLogs();
        logs.slice(-15).forEach((log) => console.log(`   ${log}`));
      }
      Alert.alert(
        'Error',
        'Failed to get chunk file. Check console for extension logs.'
      );
    }
  }, [isRecording, isChunkingActive, chunkCounter, logAudioMetricsToConsole]);

  const handleClearChunks = () => {
    setChunks([]);
    setChunkCounter(0);
    setSelectedChunk(undefined);
    ScreenRecorder.clearCache();
    console.log('🗑️ Chunks cleared');
  };

  // ============================================================================
  // STRESS TESTS
  // ============================================================================

  const [isStressTesting, setIsStressTesting] = useState(false);

  // Extension logs state (iOS only)
  const [extensionLogs, setExtensionLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [audioMetricsJson, setAudioMetricsJson] = useState('');
  const [showAudioMetrics, setShowAudioMetrics] = useState(false);

  // Camera overlay state for lipsync testing
  const [showCameraOverlay, setShowCameraOverlay] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [isThermalStressActive, setIsThermalStressActive] = useState(false);
  const [isGpuStressActive, setIsGpuStressActive] = useState(false);
  const [isNetworkStressActive, setIsNetworkStressActive] = useState(false);
  const [isMemoryStressActive, setIsMemoryStressActive] = useState(false);
  const gpuAnimationValue = useRef(new Animated.Value(0)).current;
  const gpuAnimationRef = useRef<Animated.CompositeAnimation | null>(null);
  const thermalStressStateRef = useRef<{
    active: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    iteration: number;
    lastValue: number;
  }>({
    active: false,
    timer: null,
    iteration: 0,
    lastValue: 2,
  });
  const networkStressStateRef = useRef<{
    active: boolean;
    controllers: Set<AbortController>;
    iteration: number;
  }>({
    active: false,
    controllers: new Set<AbortController>(),
    iteration: 0,
  });
  const memoryStressStateRef = useRef<{
    active: boolean;
    timer: ReturnType<typeof setInterval> | null;
    buffers: Uint8Array[];
  }>({
    active: false,
    timer: null,
    buffers: [],
  });

  const gpuLayers = useMemo(() => {
    const { width, height } = Dimensions.get('window');
    return Array.from({ length: GPU_LAYER_COUNT }, (_, index) => {
      const seed = index * 9973;
      const rand = (offset: number) =>
        Math.abs(Math.sin(seed + offset * 13.37)) % 1;
      const size =
        GPU_LAYER_MIN_SIZE +
        rand(1) * (GPU_LAYER_MAX_SIZE - GPU_LAYER_MIN_SIZE);
      const dx = (rand(2) - 0.5) * width * 1.2;
      const dy = (rand(3) - 0.5) * height * 1.2;
      const rotate = rand(4) * 360;
      const scale = 0.6 + rand(5) * 1.4;
      const opacity =
        GPU_LAYER_OPACITY_MIN +
        rand(6) * (GPU_LAYER_OPACITY_MAX - GPU_LAYER_OPACITY_MIN);
      const color = `rgba(${Math.floor(rand(7) * 255)}, ${Math.floor(
        rand(8) * 255
      )}, ${Math.floor(rand(9) * 255)}, ${opacity.toFixed(2)})`;
      const top = rand(10) * (height - size);
      const left = rand(11) * (width - size);
      return { size, dx, dy, rotate, scale, color, top, left };
    });
  }, []);

  const handleRefreshLogs = useCallback(() => {
    const logs = ScreenRecorder.getExtensionLogs();
    setExtensionLogs(logs);
    console.log(`📜 Loaded ${logs.length} extension logs`);
  }, []);

  const handleDumpAudioMetrics = useCallback(() => {
    const metricsJson = ScreenRecorder.getExtensionAudioMetrics();
    const { parsed } = formatAudioMetrics(metricsJson);
    const metricsArray = parsed?.metrics;
    const latestMetrics =
      Array.isArray(metricsArray) && metricsArray.length > 0
        ? metricsArray[metricsArray.length - 1]
        : (parsed ?? metricsJson);
    setAudioMetricsJson(JSON.stringify(latestMetrics, null, 2));
    setShowAudioMetrics(true);
    console.log('📊 Extension audio metrics (latest):', latestMetrics);
  }, [formatAudioMetrics]);

  const runThermalStress = useCallback(() => {
    if (!thermalStressStateRef.current.active) {
      return;
    }

    const start = performance.now();
    let n = thermalStressStateRef.current.lastValue;
    let accumulator = 0;

    while (performance.now() - start < THERMAL_STRESS_CHUNK_MS) {
      let isPrime = true;
      for (let i = 2; i * i <= n; i++) {
        if (n % i === 0) {
          isPrime = false;
          break;
        }
      }
      if (isPrime) {
        accumulator += n;
      }
      n += 1;
    }

    thermalStressStateRef.current.lastValue = n + (accumulator % 2);
    thermalStressStateRef.current.iteration += 1;

    if (thermalStressStateRef.current.iteration % 30 === 0) {
      console.log(
        `🔥 Thermal stress tick (${thermalStressStateRef.current.iteration})`
      );
    }

    thermalStressStateRef.current.timer = setTimeout(
      runThermalStress,
      THERMAL_STRESS_PAUSE_MS
    );
  }, []);

  const startGpuStress = useCallback(() => {
    if (gpuAnimationRef.current) {
      return;
    }
    setIsGpuStressActive(true);
    gpuAnimationValue.setValue(0);
    gpuAnimationRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(gpuAnimationValue, {
          toValue: 1,
          duration: GPU_ANIMATION_DURATION_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(gpuAnimationValue, {
          toValue: 0,
          duration: GPU_ANIMATION_DURATION_MS,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ])
    );
    gpuAnimationRef.current.start();
  }, [gpuAnimationValue]);

  const stopGpuStress = useCallback(() => {
    gpuAnimationRef.current?.stop();
    gpuAnimationRef.current = null;
    setIsGpuStressActive(false);
  }, []);

  const runNetworkStressLoop = useCallback(async () => {
    const state = networkStressStateRef.current;
    while (state.active) {
      const controller = new AbortController();
      state.controllers.add(controller);
      try {
        const response = await fetch(NETWORK_STRESS_URL, {
          cache: 'no-store',
          signal: controller.signal,
        });
        await response.arrayBuffer();
        state.iteration += 1;
        if (state.iteration % 5 === 0) {
          console.log(`🌐 Network stress tick (${state.iteration})`);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('🌐 Network stress error', error);
        }
      } finally {
        state.controllers.delete(controller);
      }
      if (NETWORK_STRESS_PAUSE_MS > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, NETWORK_STRESS_PAUSE_MS)
        );
      }
    }
  }, []);

  const startNetworkStress = useCallback(() => {
    const state = networkStressStateRef.current;
    if (state.active) {
      return;
    }
    state.active = true;
    state.iteration = 0;
    setIsNetworkStressActive(true);
    for (let i = 0; i < NETWORK_STRESS_CONCURRENCY; i += 1) {
      runNetworkStressLoop().catch((error) => {
        console.warn('🌐 Network stress loop error', error);
      });
    }
  }, [runNetworkStressLoop]);

  const stopNetworkStress = useCallback(() => {
    const state = networkStressStateRef.current;
    state.active = false;
    state.controllers.forEach((controller) => controller.abort());
    state.controllers.clear();
    setIsNetworkStressActive(false);
  }, []);

  const startMemoryStress = useCallback(() => {
    const state = memoryStressStateRef.current;
    if (state.active) {
      return;
    }
    state.active = true;
    setIsMemoryStressActive(true);
    state.timer = setInterval(() => {
      if (!state.active) {
        return;
      }
      try {
        const chunkSizeBytes = MEMORY_STRESS_CHUNK_MB * 1024 * 1024;
        const buffer = new Uint8Array(chunkSizeBytes);
        buffer[0] = state.buffers.length % 255;
        state.buffers.push(buffer);
        if (state.buffers.length > MEMORY_STRESS_MAX_BUFFERS) {
          state.buffers.shift();
        }
      } catch (error) {
        console.warn('🧠 Memory stress error', error);
      }
    }, MEMORY_STRESS_INTERVAL_MS);
  }, []);

  const stopMemoryStress = useCallback(() => {
    const state = memoryStressStateRef.current;
    state.active = false;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.buffers = [];
    setIsMemoryStressActive(false);
  }, []);

  const startThermalStress = useCallback(() => {
    if (thermalStressStateRef.current.active) {
      return;
    }
    thermalStressStateRef.current.active = true;
    thermalStressStateRef.current.iteration = 0;
    setIsThermalStressActive(true);
    runThermalStress();
  }, [runThermalStress]);

  const stopThermalStress = useCallback(() => {
    thermalStressStateRef.current.active = false;
    if (thermalStressStateRef.current.timer) {
      clearTimeout(thermalStressStateRef.current.timer);
      thermalStressStateRef.current.timer = null;
    }
    setIsThermalStressActive(false);
  }, []);

  const startKitchenSinkStress = useCallback(() => {
    startThermalStress();
    startGpuStress();
    startNetworkStress();
    startMemoryStress();
  }, [
    startGpuStress,
    startMemoryStress,
    startNetworkStress,
    startThermalStress,
  ]);

  const stopKitchenSinkStress = useCallback(() => {
    stopThermalStress();
    stopGpuStress();
    stopNetworkStress();
    stopMemoryStress();
  }, [stopGpuStress, stopMemoryStress, stopNetworkStress, stopThermalStress]);

  useEffect(() => {
    return () => {
      stopThermalStress();
      stopGpuStress();
      stopNetworkStress();
      stopMemoryStress();
    };
  }, [stopGpuStress, stopMemoryStress, stopNetworkStress, stopThermalStress]);

  const stressTestRapidChunks = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Rapid Chunk Cycling');
    const results: { id: string; success: boolean; duration?: number }[] = [];

    for (let i = 1; i <= 5; i++) {
      const chunkId = `rapid-${i}`;
      console.log(`   Starting chunk ${chunkId}...`);
      ScreenRecorder.markChunkStart(chunkId);

      // Short recording (1 second)
      await new Promise((r) => setTimeout(r, 1500));

      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
      const elapsed = (performance.now() - t0).toFixed(0);
      results.push({ id: chunkId, success: !!file, duration: file?.duration });
      console.log(
        `   Chunk ${chunkId}: ${file ? '✅' : '❌'} (${file?.duration?.toFixed(1) ?? 0}s) [${elapsed}ms]`
      );

      // On failure, dump extension logs immediately
      if (!file && Platform.OS === 'ios') {
        console.log(`   📜 Extension logs after ${chunkId} failure:`);
        const logs = ScreenRecorder.getExtensionLogs();
        logs.slice(-10).forEach((log) => console.log(`      ${log}`));
      }
    }

    const passed = results.filter((r) => r.success).length;
    setIsStressTesting(false);

    // Always dump logs at end if any failures
    if (passed < 5 && Platform.OS === 'ios') {
      console.log('📜 Full extension logs:');
      const logs = ScreenRecorder.getExtensionLogs();
      logs.forEach((log) => console.log(`   ${log}`));
    }

    Alert.alert('Rapid Chunks', `${passed}/5 chunks retrieved successfully`);
  }, [isRecording]);

  const stressTestDuplicateId = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Duplicate ID');

    // First recording with ID "duplicate-test"
    ScreenRecorder.markChunkStart('duplicate-test');
    await new Promise((r) => setTimeout(r, 1000));
    await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });

    // Second recording with SAME ID
    ScreenRecorder.markChunkStart('duplicate-test');
    await new Promise((r) => setTimeout(r, 2000)); // Longer, different duration
    const t0 = performance.now();
    const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
    console.log(
      `   finalizeChunk took ${(performance.now() - t0).toFixed(0)}ms`
    );

    // Should get the SECOND recording (newer), not the first
    const isLonger = file && file.duration > 1.5;
    console.log(`   Duration: ${file?.duration?.toFixed(1)}s (expected >1.5s)`);

    setIsStressTesting(false);
    Alert.alert(
      'Duplicate ID Test',
      isLonger ? '✅ Got newer recording' : '❌ Got older recording or none'
    );
  }, [isRecording]);

  const stressTestMissingId = useCallback(async () => {
    console.log('🧪 Stress Test: Missing ID');

    const file = ScreenRecorder.retrieveGlobalRecording(
      'this-id-does-not-exist'
    );

    if (file === null || file === undefined) {
      console.log('   ✅ Correctly returned nil for missing ID');
      Alert.alert('Missing ID Test', '✅ Correctly returned nil');
    } else {
      console.log('   ❌ Unexpectedly returned a file!');
      Alert.alert('Missing ID Test', '❌ Should have returned nil');
    }
  }, []);

  const stressTestAudioPairing = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Audio Pairing');
    const results: {
      id: string;
      videoDuration: number;
      audioDuration: number;
      match: boolean;
    }[] = [];

    for (let i = 1; i <= 3; i++) {
      const chunkId = `audio-${i}`;
      ScreenRecorder.markChunkStart(chunkId);

      // Different durations for each chunk
      await new Promise((r) => setTimeout(r, 1000 * i));

      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
      const elapsed = (performance.now() - t0).toFixed(0);

      if (file && file.audioFile) {
        const videoDur = file.duration;
        const audioDur = file.audioFile.duration;
        // Audio should roughly match video duration (within 0.5s)
        const match = Math.abs(videoDur - audioDur) < 0.5;
        results.push({
          id: chunkId,
          videoDuration: videoDur,
          audioDuration: audioDur,
          match,
        });
        console.log(
          `   ${chunkId}: video=${videoDur.toFixed(1)}s, audio=${audioDur.toFixed(1)}s ${match ? '✅' : '❌'} [${elapsed}ms]`
        );
      } else {
        console.log(`   ${chunkId}: ❌ No file returned [${elapsed}ms]`);
        // Dump extension logs on failure
        if (Platform.OS === 'ios') {
          console.log(`   📜 Extension logs after ${chunkId} failure:`);
          const logs = ScreenRecorder.getExtensionLogs();
          logs.slice(-15).forEach((log) => console.log(`      ${log}`));
        }
      }
    }

    const passed = results.filter((r) => r.match).length;
    setIsStressTesting(false);
    Alert.alert(
      'Audio Pairing',
      `${passed}/${results.length} audio files match video duration`
    );
  }, [isRecording]);

  const stressTestLongRecording = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Long Recording (10s)');

    ScreenRecorder.markChunkStart('long-recording');
    console.log('   Recording for 10 seconds...');

    await new Promise((r) => setTimeout(r, 10000));

    console.log('   Finalizing...');
    const t0 = performance.now();
    const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
    const elapsed = (performance.now() - t0).toFixed(0);

    setIsStressTesting(false);

    if (file) {
      console.log(`   ✅ Got file in ${elapsed}ms`);
      console.log(`   Duration: ${file.duration.toFixed(1)}s`);
      console.log(`   Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);
      Alert.alert(
        'Long Recording',
        `✅ ${file.duration.toFixed(1)}s, ${(file.size / 1024 / 1024).toFixed(2)} MB\nFinalized in ${elapsed}ms`
      );
    } else {
      console.log(`   ❌ No file returned after ${elapsed}ms`);
      // Dump extension logs on failure
      if (Platform.OS === 'ios') {
        console.log(`   📜 Extension logs after Long Recording failure:`);
        const logs = ScreenRecorder.getExtensionLogs();
        logs.slice(-15).forEach((log) => console.log(`      ${log}`));
      }
      Alert.alert('Long Recording', `❌ No file returned after ${elapsed}ms`);
    }
  }, [isRecording]);

  const stressTestRaceCondition = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Race Conditions');
    const results: { test: string; passed: boolean; detail: string }[] = [];

    // Test 1: Start Q2 before Q1's finalizeChunk completes
    console.log('   Test 1: Overlapping mark/finalize');
    ScreenRecorder.markChunkStart('race-q1');
    await new Promise((r) => setTimeout(r, 1500));

    // Start finalizing Q1, but DON'T await yet
    const q1Promise = ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });

    // Immediately start Q2 (race condition scenario)
    ScreenRecorder.markChunkStart('race-q2');
    await new Promise((r) => setTimeout(r, 1500));

    // Now await Q1
    const q1File = await q1Promise;
    const q1Passed = q1File !== null && q1File.duration > 1;
    results.push({
      test: 'Overlapping mark/finalize',
      passed: q1Passed,
      detail: q1File ? `Q1: ${q1File.duration.toFixed(1)}s` : 'Q1: null',
    });
    console.log(
      `   Q1 result: ${q1Passed ? '✅' : '❌'} ${q1File?.duration?.toFixed(1) ?? 'null'}s`
    );

    // Finalize Q2
    const t0 = performance.now();
    const q2File = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
    const q2Elapsed = (performance.now() - t0).toFixed(0);
    const q2Passed = q2File !== null && q2File.duration > 1;
    results.push({
      test: 'Q2 after overlap',
      passed: q2Passed,
      detail: q2File
        ? `Q2: ${q2File.duration.toFixed(1)}s [${q2Elapsed}ms]`
        : 'Q2: null',
    });
    console.log(
      `   Q2 result: ${q2Passed ? '✅' : '❌'} ${q2File?.duration?.toFixed(1) ?? 'null'}s [${q2Elapsed}ms]`
    );

    // Test 2: Concurrent finalizeChunk calls (should be rejected)
    console.log('   Test 2: Concurrent finalizeChunk (should reject second)');
    ScreenRecorder.markChunkStart('race-concurrent');
    await new Promise((r) => setTimeout(r, 1000));

    // Fire two finalizeChunks at once
    const [f1, f2] = await Promise.all([
      ScreenRecorder.finalizeChunk({ settledTimeMs: 500 }),
      ScreenRecorder.finalizeChunk({ settledTimeMs: 500 }),
    ]);

    const bothSucceeded = f1 !== null && f2 !== null;
    results.push({
      test: 'Concurrent finalizeChunk',
      passed: !bothSucceeded, // Pass if second was rejected OR only one succeeded
      detail: `f1: ${f1 ? 'file' : 'null'}, f2: ${f2 ? 'file' : 'null'}`,
    });
    console.log(
      `   Concurrent result: f1=${f1 ? '✅' : '❌'}, f2=${f2 ? '✅' : '❌'} (expect one null)`
    );

    // Test 3: Rapid fire (no await between cycles)
    console.log('   Test 3: Rapid fire mark/finalize');
    const rapidResults: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      ScreenRecorder.markChunkStart(`rapid-race-${i}`);
      await new Promise((r) => setTimeout(r, 800));
      const t1 = performance.now();
      const f = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
      const e = (performance.now() - t1).toFixed(0);
      rapidResults.push(f !== null);
      console.log(`   rapid-${i}: ${f ? '✅' : '❌'} [${e}ms]`);
    }
    results.push({
      test: 'Rapid fire',
      passed: rapidResults.every((r) => r),
      detail: `${rapidResults.filter((r) => r).length}/3 succeeded`,
    });

    setIsStressTesting(false);
    Alert.alert(
      'Race Conditions',
      results
        .map((r) => `${r.passed ? '✅' : '❌'} ${r.test}: ${r.detail}`)
        .join('\n')
    );
  }, [isRecording]);

  const stressTestAudioMismatch = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Aggressive Audio Mismatch Detection');
    console.log('   Recording 5 chunks with DISTINCT durations...');

    // Each chunk has a unique duration so we can detect mismatches
    const expectedDurations = [2, 4, 3, 5, 1]; // seconds - intentionally not sequential
    const results: {
      chunk: number;
      expectedDur: number;
      videoDur: number;
      audioDur: number;
      videoMatch: boolean;
      audioMatch: boolean;
    }[] = [];

    for (let i = 0; i < expectedDurations.length; i++) {
      const expectedDur = expectedDurations[i];
      console.log(`   Chunk ${i + 1}: Recording for ${expectedDur}s...`);

      ScreenRecorder.markChunkStart(`mismatch-${i}`);
      await new Promise((r) => setTimeout(r, expectedDur * 1000));

      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
      const elapsed = (performance.now() - t0).toFixed(0);

      if (file) {
        const videoDur = file.duration;
        const audioDur = file.audioFile?.duration ?? 0;

        // Video should be within 0.5s of expected
        const videoMatch = Math.abs(videoDur - expectedDur) < 0.5;
        // Audio should match video (within 0.3s)
        const audioMatch = file.audioFile
          ? Math.abs(videoDur - audioDur) < 0.3
          : true; // No audio file is OK if mic not enabled

        results.push({
          chunk: i + 1,
          expectedDur,
          videoDur,
          audioDur,
          videoMatch,
          audioMatch,
        });

        const status = videoMatch && audioMatch ? '✅' : '❌';
        console.log(
          `   Chunk ${i + 1}: ${status} expected=${expectedDur}s, video=${videoDur.toFixed(1)}s, audio=${audioDur.toFixed(1)}s [${elapsed}ms]`
        );

        if (!videoMatch) {
          console.log(`      ⚠️ VIDEO MISMATCH: Got wrong chunk!`);
        }
        if (!audioMatch && file.audioFile) {
          console.log(`      ⚠️ AUDIO MISMATCH: Audio doesn't match video!`);
        }
      } else {
        console.log(`   Chunk ${i + 1}: ❌ No file returned [${elapsed}ms]`);
        // Dump extension logs on failure
        if (Platform.OS === 'ios') {
          console.log(`   📜 Extension logs after Chunk ${i + 1} failure:`);
          const logs = ScreenRecorder.getExtensionLogs();
          logs.slice(-15).forEach((log) => console.log(`      ${log}`));
        }
        results.push({
          chunk: i + 1,
          expectedDur,
          videoDur: 0,
          audioDur: 0,
          videoMatch: false,
          audioMatch: false,
        });
      }
    }

    setIsStressTesting(false);

    const videoMatches = results.filter((r) => r.videoMatch).length;
    const audioMatches = results.filter((r) => r.audioMatch).length;
    const allPassed = videoMatches === 5 && audioMatches === 5;

    console.log(`   Summary: Video ${videoMatches}/5, Audio ${audioMatches}/5`);

    Alert.alert(
      allPassed
        ? '✅ Audio Mismatch Test Passed'
        : '❌ Audio Mismatch Test Failed',
      results
        .map(
          (r) =>
            `Chunk ${r.chunk}: ${r.videoMatch && r.audioMatch ? '✅' : '❌'} ` +
            `exp=${r.expectedDur}s vid=${r.videoDur.toFixed(1)}s aud=${r.audioDur.toFixed(1)}s`
        )
        .join('\n')
    );
  }, [isRecording]);

  const stressTestRealisticInterview = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🧪 Stress Test: Realistic Interview (5 questions, 3-6s each)');

    // Simulate realistic interview: 5 questions with 3-6 second answers
    const questionDurations = [4, 5, 3, 6, 4]; // seconds per answer
    const results: {
      question: number;
      expectedDur: number;
      actualDur: number;
      audioDur: number;
      success: boolean;
      finalizeTime: number;
    }[] = [];

    for (let i = 0; i < questionDurations.length; i++) {
      const expectedDur = questionDurations[i];
      console.log(`   Q${i + 1}: Answering for ${expectedDur}s...`);

      // Start tracking this answer
      ScreenRecorder.markChunkStart(`interview-q${i + 1}`);

      // Simulate user answering
      await new Promise((r) => setTimeout(r, expectedDur * 1000));

      // Finalize and submit
      console.log(`   Q${i + 1}: Submitting answer...`);
      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
      const finalizeTime = performance.now() - t0;

      if (file) {
        const durationMatch = Math.abs(file.duration - expectedDur) < 0.5;
        const audioMatch = file.audioFile
          ? Math.abs(file.duration - file.audioFile.duration) < 0.3
          : true;
        const success = durationMatch && audioMatch;

        results.push({
          question: i + 1,
          expectedDur,
          actualDur: file.duration,
          audioDur: file.audioFile?.duration ?? 0,
          success,
          finalizeTime,
        });

        console.log(
          `   Q${i + 1}: ${success ? '✅' : '❌'} ` +
            `${file.duration.toFixed(1)}s video, ${file.audioFile?.duration.toFixed(1) ?? 'n/a'}s audio ` +
            `[${finalizeTime.toFixed(0)}ms]`
        );
      } else {
        results.push({
          question: i + 1,
          expectedDur,
          actualDur: 0,
          audioDur: 0,
          success: false,
          finalizeTime,
        });
        console.log(
          `   Q${i + 1}: ❌ No file returned [${finalizeTime.toFixed(0)}ms]`
        );
        // Dump extension logs on failure
        if (Platform.OS === 'ios') {
          console.log(`   📜 Extension logs after Q${i + 1} failure:`);
          const logs = ScreenRecorder.getExtensionLogs();
          logs.slice(-15).forEach((log) => console.log(`      ${log}`));
        }
      }

      // Brief pause between questions (simulating UI transition)
      if (i < questionDurations.length - 1) {
        console.log(`   (transitioning to next question...)`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    setIsStressTesting(false);

    const passed = results.filter((r) => r.success).length;
    const avgFinalizeTime =
      results.reduce((sum, r) => sum + r.finalizeTime, 0) / results.length;

    console.log(
      `   Summary: ${passed}/5 passed, avg finalize: ${avgFinalizeTime.toFixed(0)}ms`
    );

    Alert.alert(
      passed === 5 ? '✅ Interview Test Passed' : '❌ Interview Test Failed',
      `${passed}/5 questions succeeded\n` +
        `Avg finalize time: ${avgFinalizeTime.toFixed(0)}ms\n\n` +
        results
          .map(
            (r) =>
              `Q${r.question}: ${r.success ? '✅' : '❌'} ${r.actualDur.toFixed(1)}s [${r.finalizeTime.toFixed(0)}ms]`
          )
          .join('\n')
    );
  }, [isRecording]);

  const stressTestHardMode = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);

    const numQuestions = 40;
    // Generate random durations between 0.5s and 15s
    const questionDurations = Array.from(
      { length: numQuestions },
      () => Math.random() * 14.5 + 0.5
    );

    const totalExpectedTime = questionDurations.reduce((a, b) => a + b, 0);
    console.log(
      `🔥 HARD MODE: ${numQuestions} questions, ~${Math.round(totalExpectedTime)}s total expected`
    );
    console.log(
      `   Durations: ${questionDurations.map((d) => d.toFixed(1)).join(', ')}`
    );

    const results: {
      question: number;
      expectedDur: number;
      actualDur: number;
      audioDur: number;
      success: boolean;
      noFile: boolean;
      finalizeTime: number;
    }[] = [];

    const testStartTime = performance.now();

    for (let i = 0; i < questionDurations.length; i++) {
      const expectedDur = questionDurations[i];
      console.log(
        `   Q${i + 1}/${numQuestions}: Recording for ${expectedDur.toFixed(1)}s...`
      );

      // Start tracking this answer
      ScreenRecorder.markChunkStart(`hardmode-q${i + 1}`);

      // Simulate recording
      await new Promise((r) => setTimeout(r, expectedDur * 1000));

      // Finalize and submit
      console.log(`   Q${i + 1}/${numQuestions}: Finalizing...`);
      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 500 });
      const finalizeTime = performance.now() - t0;

      if (file) {
        // Wider tolerance for short recordings (< 2s get ±1s, others get ±0.5s)
        const tolerance = expectedDur < 2 ? 1.0 : 0.5;
        const durationMatch = Math.abs(file.duration - expectedDur) < tolerance;
        const audioMatch = file.audioFile
          ? Math.abs(file.duration - file.audioFile.duration) < 0.5
          : true;
        const success = durationMatch && audioMatch;

        results.push({
          question: i + 1,
          expectedDur,
          actualDur: file.duration,
          audioDur: file.audioFile?.duration ?? 0,
          success,
          noFile: false,
          finalizeTime,
        });

        const emoji = success ? '✅' : '❌';
        const diff = file.duration - expectedDur;
        const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
        console.log(
          `   Q${i + 1}/${numQuestions}: ${emoji} ${file.duration.toFixed(1)}s (${diffStr}s) [${finalizeTime.toFixed(0)}ms]`
        );
      } else {
        results.push({
          question: i + 1,
          expectedDur,
          actualDur: 0,
          audioDur: 0,
          success: false,
          noFile: true,
          finalizeTime,
        });
        console.log(
          `   Q${i + 1}/${numQuestions}: ❌ No file returned [${finalizeTime.toFixed(0)}ms]`
        );
        // Dump extension logs only when no file returned
        if (Platform.OS === 'ios') {
          console.log(
            `   📜 Extension logs after Q${i + 1} failure (no file):`
          );
          const logs = ScreenRecorder.getExtensionLogs();
          logs.slice(-15).forEach((log) => console.log(`      ${log}`));
        }
      }

      // Brief pause between questions
      if (i < questionDurations.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    const testDuration = (performance.now() - testStartTime) / 1000;
    setIsStressTesting(false);

    const passed = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success);
    const noFileCount = results.filter((r) => r.noFile).length;
    const avgFinalizeTime =
      results.reduce((sum, r) => sum + r.finalizeTime, 0) / results.length;
    const actualDurations = results
      .map((r) => r.actualDur)
      .filter((d) => d > 0);
    const minDur =
      actualDurations.length > 0 ? Math.min(...actualDurations) : 0;
    const maxDur =
      actualDurations.length > 0 ? Math.max(...actualDurations) : 0;
    const avgDur =
      actualDurations.length > 0
        ? actualDurations.reduce((a, b) => a + b, 0) / actualDurations.length
        : 0;

    console.log(`\n🔥 HARD MODE RESULTS:`);
    console.log(
      `   Passed: ${passed}/${numQuestions} (${((passed / numQuestions) * 100).toFixed(0)}%)`
    );
    console.log(`   No file returned: ${noFileCount}`);
    console.log(`   Test duration: ${testDuration.toFixed(0)}s`);
    console.log(`   Avg finalize: ${avgFinalizeTime.toFixed(0)}ms`);
    if (actualDurations.length > 0) {
      console.log(
        `   Duration range: ${minDur.toFixed(1)}s - ${maxDur.toFixed(1)}s (avg: ${avgDur.toFixed(1)}s)`
      );
    }

    if (failed.length > 0) {
      console.log(
        `   Failed questions: ${failed.map((f) => f.question).join(', ')}`
      );
    }

    const passThreshold = Math.floor(numQuestions * 0.8); // 80% pass rate
    Alert.alert(
      passed >= passThreshold ? '✅ Hard Mode Passed' : '❌ Hard Mode Failed',
      `${passed}/${numQuestions} questions succeeded (${((passed / numQuestions) * 100).toFixed(0)}%)\n` +
        `No file: ${noFileCount}, Duration mismatch: ${failed.length - noFileCount}\n` +
        `Test duration: ${testDuration.toFixed(0)}s\n` +
        `Avg finalize: ${avgFinalizeTime.toFixed(0)}ms\n\n` +
        (failed.length > 0
          ? `Failed: Q${failed.map((f) => f.question).join(', Q')}`
          : 'All questions passed!')
    );
  }, [isRecording]);

  // Faster chunk test - 20 iterations with shorter timing
  const stressTestFasterChunks = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('🚀 Stress Test: Faster Chunks (20 iterations, 500ms each)');
    const results: { id: string; success: boolean; duration?: number }[] = [];

    for (let i = 1; i <= 20; i++) {
      const chunkId = `fast-${i}`;
      console.log(`   Starting chunk ${chunkId}...`);
      ScreenRecorder.markChunkStart(chunkId);

      // Very short recording (500ms)
      await new Promise((r) => setTimeout(r, 500));

      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 200 });
      const elapsed = (performance.now() - t0).toFixed(0);
      results.push({ id: chunkId, success: !!file, duration: file?.duration });
      console.log(
        `   Chunk ${chunkId}: ${file ? '✅' : '❌'} (${file?.duration?.toFixed(2) ?? 0}s) [${elapsed}ms]`
      );

      if (!file && Platform.OS === 'ios') {
        console.log(`   📜 Extension logs after ${chunkId} failure:`);
        const logs = ScreenRecorder.getExtensionLogs();
        logs.slice(-8).forEach((log) => console.log(`      ${log}`));
      }
    }

    const passed = results.filter((r) => r.success).length;
    setIsStressTesting(false);

    if (passed < 20 && Platform.OS === 'ios') {
      console.log('📜 Full extension logs:');
      const logs = ScreenRecorder.getExtensionLogs();
      logs.forEach((log) => console.log(`   ${log}`));
    }

    Alert.alert('Faster Chunks', `${passed}/20 chunks retrieved successfully`);
  }, [isRecording]);

  // Rapid mark spam test - multiple marks before finalize
  const stressTestMarkSpam = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('📨 Stress Test: Mark Spam (multiple marks before finalize)');
    console.log('   Testing that rapid marks are handled without crashing');
    const results: { round: number; success: boolean; duration?: number }[] =
      [];

    for (let round = 1; round <= 5; round++) {
      console.log(`   Round ${round}: Spamming 5 marks rapidly...`);

      // Fire 5 marks rapidly - system should handle this gracefully
      for (let i = 1; i <= 5; i++) {
        ScreenRecorder.markChunkStart(`spam-r${round}-m${i}`);
        await new Promise((r) => setTimeout(r, 10)); // tiny 10ms delay
      }

      // Record for a bit after the spam
      await new Promise((r) => setTimeout(r, 800));

      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 200 });
      const elapsed = (performance.now() - t0).toFixed(0);

      results.push({
        round,
        success: !!file,
        duration: file?.duration,
      });

      console.log(
        `   Round ${round}: ${file ? '✅' : '❌'} (${file?.duration?.toFixed(2) ?? 0}s) [${elapsed}ms]`
      );

      if (!file && Platform.OS === 'ios') {
        console.log(`   📜 Extension logs after round ${round} failure:`);
        const logs = ScreenRecorder.getExtensionLogs();
        logs.slice(-8).forEach((log) => console.log(`      ${log}`));
      }
    }

    const passed = results.filter((r) => r.success).length;
    setIsStressTesting(false);

    Alert.alert(
      'Mark Spam Results',
      `${passed}/5 rounds retrieved successfully\n(5 rapid marks per round)`
    );
  }, [isRecording]);

  // No-gap burst test - back-to-back without pause
  const stressTestNoGapBurst = useCallback(async () => {
    if (!isRecording) {
      Alert.alert('Not Recording', 'Start a global recording first');
      return;
    }
    setIsStressTesting(true);
    console.log('💥 Stress Test: No-Gap Burst (back-to-back, no pause)');
    const results: {
      id: string;
      success: boolean;
      duration?: number;
      finalizeMs: number;
    }[] = [];

    for (let i = 1; i <= 15; i++) {
      const chunkId = `burst-${i}`;

      // Mark immediately (no delay from previous finalize)
      ScreenRecorder.markChunkStart(chunkId);

      // Short recording
      await new Promise((r) => setTimeout(r, 600));

      const t0 = performance.now();
      const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 150 });
      const finalizeMs = performance.now() - t0;

      results.push({
        id: chunkId,
        success: !!file,
        duration: file?.duration,
        finalizeMs,
      });

      console.log(
        `   ${chunkId}: ${file ? '✅' : '❌'} (${file?.duration?.toFixed(2) ?? 0}s) [${finalizeMs.toFixed(0)}ms]`
      );

      // NO delay before next iteration - that's the point of this test
    }

    const passed = results.filter((r) => r.success).length;
    const avgFinalize =
      results.reduce((sum, r) => sum + r.finalizeMs, 0) / results.length;
    setIsStressTesting(false);

    if (passed < 15 && Platform.OS === 'ios') {
      console.log('📜 Full extension logs:');
      const logs = ScreenRecorder.getExtensionLogs();
      logs.slice(-30).forEach((log) => console.log(`   ${log}`));
    }

    Alert.alert(
      'No-Gap Burst',
      `${passed}/15 chunks retrieved\nAvg finalize: ${avgFinalize.toFixed(0)}ms`
    );
  }, [isRecording]);

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

  // Camera overlay toggle handler
  const handleToggleCameraOverlay = async () => {
    if (!showCameraOverlay) {
      // Request permission if not granted
      if (!cameraPermission?.granted) {
        const result = await requestCameraPermission();
        if (!result.granted) {
          Alert.alert(
            'Camera Permission',
            'Camera permission is required for the overlay'
          );
          return;
        }
      }
    }
    setShowCameraOverlay(!showCameraOverlay);
  };

  const isKitchenSinkActive =
    isThermalStressActive &&
    isGpuStressActive &&
    isNetworkStressActive &&
    isMemoryStressActive;

  return (
    <View style={styles.root}>
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

        {/* Camera Overlay Section for Lipsync Testing */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            📹 Camera Overlay (Lipsync Test)
          </Text>
          <Text style={styles.description}>
            Toggle camera overlay to see yourself while recording for lipsync
            testing.
          </Text>
          <TouchableOpacity
            style={[
              styles.button,
              showCameraOverlay ? styles.stopButton : styles.startButton,
            ]}
            onPress={handleToggleCameraOverlay}
          >
            <Text style={styles.buttonText}>
              {showCameraOverlay
                ? '📷 Hide Camera Overlay'
                : '📷 Show Camera Overlay'}
            </Text>
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

        {/* Stress Tests Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🧪 Stress Tests</Text>
          <Text style={styles.description}>
            Run these while global recording is active to test chunk ID
            matching.
          </Text>

          <View style={styles.stressTestGrid}>
            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestRapidChunks}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '⚡'} Rapid Chunks
              </Text>
              <Text style={styles.stressTestSubtext}>5 quick cycles</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestDuplicateId}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>🔄 Duplicate ID</Text>
              <Text style={styles.stressTestSubtext}>Same ID twice</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                isStressTesting && styles.disabledButton,
              ]}
              onPress={stressTestMissingId}
              disabled={isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>❓ Missing ID</Text>
              <Text style={styles.stressTestSubtext}>Non-existent chunk</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestAudioPairing}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>🎵 Audio Pairing</Text>
              <Text style={styles.stressTestSubtext}>3 chunks with audio</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestLongRecording}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '🎬'} Long Recording
              </Text>
              <Text style={styles.stressTestSubtext}>10 second chunk</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestRaceCondition}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '🏁'} Race Conditions
              </Text>
              <Text style={styles.stressTestSubtext}>Overlap + concurrent</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestAudioMismatch}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '🔊'} Audio Mismatch
              </Text>
              <Text style={styles.stressTestSubtext}>
                5 chunks, distinct durations
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestRealisticInterview}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '🎤'} Interview Sim
              </Text>
              <Text style={styles.stressTestSubtext}>
                5 questions, 3-6s each
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestHardMode}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '🔥'} Hard Mode
              </Text>
              <Text style={styles.stressTestSubtext}>40 Q, 0.5s-15s each</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestFasterChunks}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '🚀'} Faster Chunks
              </Text>
              <Text style={styles.stressTestSubtext}>20x 500ms chunks</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestMarkSpam}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '📨'} Mark Spam
              </Text>
              <Text style={styles.stressTestSubtext}>
                5 marks before finalize
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.stressTestButton,
                (!isRecording || isStressTesting) && styles.disabledButton,
              ]}
              onPress={stressTestNoGapBurst}
              disabled={!isRecording || isStressTesting}
            >
              <Text style={styles.stressTestButtonText}>
                {isStressTesting ? '⏳' : '💥'} No-Gap Burst
              </Text>
              <Text style={styles.stressTestSubtext}>15x back-to-back</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Device Heat Test */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🔥 Device Heat Test</Text>
          <Text style={styles.description}>
            Extreme CPU load to warm the device. Expect heavy battery drain and
            UI jank.
          </Text>
          <TouchableOpacity
            style={[
              styles.button,
              isThermalStressActive ? styles.stopButton : styles.startButton,
            ]}
            onPress={
              isThermalStressActive ? stopThermalStress : startThermalStress
            }
          >
            <Text style={styles.buttonText}>
              {isThermalStressActive ? 'Stop Heat Test' : 'Start Heat Test'}
            </Text>
          </TouchableOpacity>
          {isThermalStressActive && (
            <Text style={styles.thermalStatus}>Running heavy CPU load…</Text>
          )}
        </View>

        {/* Kitchen Sink Stress */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>🧨 Kitchen Sink Stress</Text>
          <Text style={styles.description}>
            CPU + GPU + network + memory pressure all at once.
          </Text>
          <TouchableOpacity
            style={[
              styles.button,
              isKitchenSinkActive ? styles.stopButton : styles.startButton,
            ]}
            onPress={
              isKitchenSinkActive
                ? stopKitchenSinkStress
                : startKitchenSinkStress
            }
          >
            <Text style={styles.buttonText}>
              {isKitchenSinkActive
                ? 'Stop All Stressors'
                : 'Start All Stressors'}
            </Text>
          </TouchableOpacity>
          <View style={styles.stressToggleRow}>
            <TouchableOpacity
              style={[
                styles.stressToggle,
                isThermalStressActive && styles.stressToggleActive,
              ]}
              onPress={
                isThermalStressActive ? stopThermalStress : startThermalStress
              }
            >
              <Text style={styles.stressToggleText}>CPU</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.stressToggle,
                isGpuStressActive && styles.stressToggleActive,
              ]}
              onPress={isGpuStressActive ? stopGpuStress : startGpuStress}
            >
              <Text style={styles.stressToggleText}>GPU</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.stressToggle,
                isNetworkStressActive && styles.stressToggleActive,
              ]}
              onPress={
                isNetworkStressActive ? stopNetworkStress : startNetworkStress
              }
            >
              <Text style={styles.stressToggleText}>Network</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.stressToggle,
                isMemoryStressActive && styles.stressToggleActive,
              ]}
              onPress={
                isMemoryStressActive ? stopMemoryStress : startMemoryStress
              }
            >
              <Text style={styles.stressToggleText}>Memory</Text>
            </TouchableOpacity>
          </View>
          {(isGpuStressActive ||
            isNetworkStressActive ||
            isMemoryStressActive) && (
            <Text style={styles.thermalStatus}>Multiple stressors active…</Text>
          )}
        </View>

        {/* Extension Logs Section (iOS only) */}
        {Platform.OS === 'ios' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>📜 Extension Logs</Text>
            <Text style={styles.description}>
              Debug logs from the broadcast extension. Use these to diagnose
              chunk/export issues.
            </Text>

            <TouchableOpacity
              style={[styles.button, styles.logsButton]}
              onPress={() => {
                handleRefreshLogs();
                setShowLogs(true);
              }}
            >
              <Text style={styles.buttonText}>📥 Load Logs</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.metricsButton]}
              onPress={handleDumpAudioMetrics}
            >
              <Text style={styles.buttonText}>📊 Dump Audio Metrics</Text>
            </TouchableOpacity>

            {showLogs && (
              <View style={styles.logsContainer}>
                <View style={styles.logsHeader}>
                  <Text style={styles.logsCount}>
                    {extensionLogs.length} log entries
                  </Text>
                  <TouchableOpacity onPress={handleRefreshLogs}>
                    <Text style={styles.refreshButton}>🔄 Refresh</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={styles.logsScroll}
                  nestedScrollEnabled={true}
                >
                  {extensionLogs.length === 0 ? (
                    <Text style={styles.logEntry}>
                      No logs available. Start a recording to generate logs.
                    </Text>
                  ) : (
                    extensionLogs.map((log, index) => (
                      <Text
                        key={index}
                        style={[
                          styles.logEntry,
                          log.includes('[ERROR]') && styles.logError,
                          log.includes('[WARN]') && styles.logWarning,
                        ]}
                      >
                        {log}
                      </Text>
                    ))
                  )}
                </ScrollView>
              </View>
            )}

            {showAudioMetrics && (
              <View style={styles.logsContainer}>
                <View style={styles.logsHeader}>
                  <Text style={styles.logsCount}>Audio metrics</Text>
                  <TouchableOpacity onPress={() => setShowAudioMetrics(false)}>
                    <Text style={styles.refreshButton}>✕ Close</Text>
                  </TouchableOpacity>
                </View>
                <ScrollView
                  style={styles.logsScroll}
                  nestedScrollEnabled={true}
                >
                  <Text style={styles.logEntry}>
                    {audioMetricsJson.length > 0
                      ? audioMetricsJson
                      : 'No metrics available. Start a recording to generate metrics.'}
                  </Text>
                </ScrollView>
              </View>
            )}
          </View>
        )}

        {/* In-App Recording Section */}
        {Platform.OS === 'ios' && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>In-App Recording</Text>
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.button, styles.startButton, styles.flexButton]}
                onPress={handleStartInAppRecording}
              >
                <Text style={styles.buttonText}>Start</Text>
              </TouchableOpacity>
              <View style={styles.buttonSpacer} />
              <TouchableOpacity
                style={[styles.button, styles.stopButton, styles.flexButton]}
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
              {globalRecording.name} •{' '}
              {formatDuration(globalRecording.duration)} •{' '}
              {formatSize(globalRecording.size)}
            </Text>
            <VideoView
              player={globalPlayer}
              style={styles.player}
              contentFit="contain"
            />
          </View>
        )}

        {/* Floating Camera Overlay for Lipsync Testing */}
        {showCameraOverlay && cameraPermission?.granted && (
          <View style={styles.cameraOverlayContainer}>
            <CameraView
              style={styles.cameraOverlay}
              facing="front"
              mirror={true}
            />
            <TouchableOpacity
              style={styles.cameraOverlayClose}
              onPress={() => setShowCameraOverlay(false)}
            >
              <Text style={styles.cameraOverlayCloseText}>✕</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
      {isGpuStressActive && (
        <View pointerEvents="none" style={styles.gpuOverlay}>
          {gpuLayers.map((layer, index) => {
            const translateX = gpuAnimationValue.interpolate({
              inputRange: [0, 1],
              outputRange: [0, layer.dx],
            });
            const translateY = gpuAnimationValue.interpolate({
              inputRange: [0, 1],
              outputRange: [0, layer.dy],
            });
            const rotate = gpuAnimationValue.interpolate({
              inputRange: [0, 1],
              outputRange: ['0deg', `${layer.rotate}deg`],
            });
            return (
              <Animated.View
                key={`gpu-layer-${index}`}
                style={[
                  styles.gpuLayer,
                  {
                    width: layer.size,
                    height: layer.size,
                    backgroundColor: layer.color,
                    top: layer.top,
                    left: layer.left,
                    transform: [
                      { translateX },
                      { translateY },
                      { rotate },
                      { scale: layer.scale },
                    ],
                  },
                ]}
              />
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
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
  flexButton: {
    flex: 1,
  },
  buttonSpacer: {
    width: 8,
  },
  startButton: {
    backgroundColor: '#34C759',
  },
  stopButton: {
    backgroundColor: '#FF3B30',
  },
  logsButton: {
    backgroundColor: '#5856D6',
  },
  metricsButton: {
    backgroundColor: '#0A84FF',
    marginTop: 8,
  },
  thermalStatus: {
    color: '#FF9F0A',
    fontSize: 12,
    marginTop: 8,
    textAlign: 'center',
  },
  stressToggleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  stressToggle: {
    backgroundColor: '#2C2C2E',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3A3A3C',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  stressToggleActive: {
    backgroundColor: '#30D158',
    borderColor: '#34C759',
  },
  stressToggleText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '600',
  },
  gpuOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 2,
    opacity: GPU_OVERLAY_OPACITY,
  },
  gpuLayer: {
    position: 'absolute',
    borderRadius: 24,
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
  stressTestGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  stressTestButton: {
    backgroundColor: '#2C2C2E',
    paddingVertical: 16,
    paddingHorizontal: 12,
    borderRadius: 12,
    alignItems: 'center',
    width: '47%',
    borderWidth: 1,
    borderColor: '#48484A',
  },
  stressTestButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  stressTestSubtext: {
    color: '#8E8E93',
    fontSize: 11,
    marginTop: 4,
  },
  // Extension Logs styles
  logsContainer: {
    marginTop: 16,
    backgroundColor: '#0A0A0A',
    borderRadius: 8,
    overflow: 'hidden',
  },
  logsHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#1C1C1E',
    borderBottomWidth: 1,
    borderBottomColor: '#2C2C2E',
  },
  logsCount: {
    color: '#8E8E93',
    fontSize: 12,
  },
  refreshButton: {
    color: '#5856D6',
    fontSize: 12,
    fontWeight: '600',
  },
  logsScroll: {
    maxHeight: 300,
    padding: 12,
  },
  logEntry: {
    color: '#C7C7CC',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
    lineHeight: 16,
  },
  logError: {
    color: '#FF453A',
  },
  logWarning: {
    color: '#FFD60A',
  },
  // Camera overlay styles for lipsync testing
  cameraOverlayContainer: {
    position: 'absolute',
    top: 100,
    right: 16,
    width: 150,
    height: 200,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 2,
    borderColor: '#5856D6',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  cameraOverlay: {
    flex: 1,
  },
  cameraOverlayClose: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cameraOverlayCloseText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
