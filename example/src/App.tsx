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
    const t0 = performance.now();
    const file = await ScreenRecorder.finalizeChunk({ settledTimeMs: 1000 });
    console.log(
      `📦 finalizeChunk took ${(performance.now() - t0).toFixed(0)}ms`
    );

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

  // ============================================================================
  // STRESS TESTS
  // ============================================================================

  const [isStressTesting, setIsStressTesting] = useState(false);

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
    }

    const passed = results.filter((r) => r.success).length;
    setIsStressTesting(false);
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

    // Generate 30 random durations between 0.5s and 30s
    const questionDurations = Array.from(
      { length: 10 },
      () => Math.random() * 29.5 + 0.5
    );

    const totalExpectedTime = questionDurations.reduce((a, b) => a + b, 0);
    console.log(
      `🔥 HARD MODE: 30 questions, ~${Math.round(totalExpectedTime)}s total expected`
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
      finalizeTime: number;
    }[] = [];

    const testStartTime = performance.now();

    for (let i = 0; i < questionDurations.length; i++) {
      const expectedDur = questionDurations[i];
      console.log(
        `   Q${i + 1}/30: Recording for ${expectedDur.toFixed(1)}s...`
      );

      // Start tracking this answer
      ScreenRecorder.markChunkStart(`hardmode-q${i + 1}`);

      // Simulate recording
      await new Promise((r) => setTimeout(r, expectedDur * 1000));

      // Finalize and submit
      console.log(`   Q${i + 1}/30: Finalizing...`);
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
          finalizeTime,
        });

        const emoji = success ? '✅' : '❌';
        const diff = file.duration - expectedDur;
        const diffStr = diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
        console.log(
          `   Q${i + 1}/30: ${emoji} ${file.duration.toFixed(1)}s (${diffStr}s) [${finalizeTime.toFixed(0)}ms]`
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
          `   Q${i + 1}/30: ❌ No file returned [${finalizeTime.toFixed(0)}ms]`
        );
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
    const avgFinalizeTime =
      results.reduce((sum, r) => sum + r.finalizeTime, 0) / results.length;
    const actualDurations = results
      .map((r) => r.actualDur)
      .filter((d) => d > 0);
    const minDur = Math.min(...actualDurations);
    const maxDur = Math.max(...actualDurations);
    const avgDur =
      actualDurations.reduce((a, b) => a + b, 0) / actualDurations.length;

    console.log(`\n🔥 HARD MODE RESULTS:`);
    console.log(
      `   Passed: ${passed}/30 (${((passed / 30) * 100).toFixed(0)}%)`
    );
    console.log(`   Test duration: ${testDuration.toFixed(0)}s`);
    console.log(`   Avg finalize: ${avgFinalizeTime.toFixed(0)}ms`);
    console.log(
      `   Duration range: ${minDur.toFixed(1)}s - ${maxDur.toFixed(1)}s (avg: ${avgDur.toFixed(1)}s)`
    );

    if (failed.length > 0) {
      console.log(
        `   Failed questions: ${failed.map((f) => f.question).join(', ')}`
      );
    }

    Alert.alert(
      passed >= 25 ? '✅ Hard Mode Passed' : '❌ Hard Mode Failed',
      `${passed}/30 questions succeeded (${((passed / 30) * 100).toFixed(0)}%)\n` +
        `Test duration: ${testDuration.toFixed(0)}s\n` +
        `Avg finalize: ${avgFinalizeTime.toFixed(0)}ms\n` +
        `Duration range: ${minDur.toFixed(1)}s - ${maxDur.toFixed(1)}s\n\n` +
        (failed.length > 0
          ? `Failed: Q${failed.map((f) => f.question).join(', Q')}`
          : 'All questions passed!')
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

      {/* Stress Tests Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>🧪 Stress Tests</Text>
        <Text style={styles.description}>
          Run these while global recording is active to test chunk ID matching.
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
            <Text style={styles.stressTestSubtext}>5 questions, 3-6s each</Text>
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
            <Text style={styles.stressTestSubtext}>30 Q, 0.5s-30s each</Text>
          </TouchableOpacity>
        </View>
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
});
