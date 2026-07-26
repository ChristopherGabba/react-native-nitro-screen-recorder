import { useState } from 'react';
import { Button, Platform, StyleSheet, Switch, Text, View } from 'react-native';
import * as ScreenRecorder from '../../src';

type PreparedConsentSessionState = 'idle' | 'prepared' | 'recording';

type PreparedConsentRecordingInput = {
  readonly options: {
    readonly enableMic: boolean;
    readonly usePreparedConsent: true;
  };
  readonly onRecordingError: (error: ScreenRecorder.RecordingError) => void;
};

type PreparedConsentScreenRecorder = typeof ScreenRecorder & {
  readonly requestScreenRecordingConsent: () => Promise<boolean>;
  readonly releaseScreenRecordingConsent: () => void;
  readonly isScreenRecordingConsentGranted: () => boolean;
  readonly getScreenRecordingSessionState: () => PreparedConsentSessionState;
  readonly startGlobalRecording: (input: PreparedConsentRecordingInput) => void;
};

const hasPreparedConsentApi = (
  module: typeof ScreenRecorder
): module is PreparedConsentScreenRecorder => {
  return (
    'requestScreenRecordingConsent' in module &&
    typeof module.requestScreenRecordingConsent === 'function' &&
    'releaseScreenRecordingConsent' in module &&
    typeof module.releaseScreenRecordingConsent === 'function' &&
    'isScreenRecordingConsentGranted' in module &&
    typeof module.isScreenRecordingConsentGranted === 'function' &&
    'getScreenRecordingSessionState' in module &&
    typeof module.getScreenRecordingSessionState === 'function'
  );
};

const getPreparedConsentApi = (): PreparedConsentScreenRecorder | undefined => {
  if (hasPreparedConsentApi(ScreenRecorder)) {
    return ScreenRecorder;
  }

  console.warn('Prepared consent API is not available in this build.');
  return undefined;
};

const logError = (label: string, error: unknown) => {
  if (error instanceof Error) {
    console.error(label, error.message);
    return;
  }

  console.error(label, error);
};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const isPermissionDeniedError = (error: unknown): boolean => {
  return getErrorMessage(error).includes('Global recording permission denied');
};

export function PreparedConsentSection() {
  const [preparedConsentState, setPreparedConsentState] =
    useState<PreparedConsentSessionState>('idle');
  const [isPreparedConsentGranted, setIsPreparedConsentGranted] =
    useState(false);
  const [enableMic, setEnableMic] = useState(false);
  const [lastResult, setLastResult] = useState('Ready');
  const [lastFilePath, setLastFilePath] = useState<string | undefined>();

  if (Platform.OS !== 'android') {
    return null;
  }

  const refreshPreparedConsentState = (): PreparedConsentSessionState => {
    const api = getPreparedConsentApi();
    if (!api) {
      setLastResult('Prepared consent API unavailable');
      return preparedConsentState;
    }

    const nextState = api.getScreenRecordingSessionState();
    const isGranted = api.isScreenRecordingConsentGranted();
    setPreparedConsentState(nextState);
    setIsPreparedConsentGranted(isGranted);
    console.log('Prepared consent state:', nextState);
    console.log('Prepared consent granted:', isGranted);
    return nextState;
  };

  const handleRequestScreenRecordingConsent = async () => {
    const api = getPreparedConsentApi();
    if (!api) return;

    try {
      setLastResult('Preparing consent...');
      const granted = await api.requestScreenRecordingConsent();
      const nextState = refreshPreparedConsentState();
      setLastResult(
        granted
          ? `Prepared consent granted (${nextState})`
          : 'Prepared consent denied'
      );
      console.log('Prepared consent granted:', granted);
      console.log('Prepared consent state:', nextState);
    } catch (error) {
      refreshPreparedConsentState();
      if (isPermissionDeniedError(error)) {
        setLastResult('Prepared consent denied');
        console.log('Prepared consent denied');
        return;
      }

      setLastResult(`Prepare failed: ${getErrorMessage(error)}`);
      logError('Prepared consent request failed:', error);
    }
  };

  const handleReleaseScreenRecordingConsent = () => {
    const api = getPreparedConsentApi();
    if (!api) return;

    api.releaseScreenRecordingConsent();
    const nextState = refreshPreparedConsentState();
    setLastResult(`Prepared consent released (${nextState})`);
    console.log('Prepared consent released. State:', nextState);
  };

  const handleStartPreparedGlobalRecording = () => {
    const api = getPreparedConsentApi();
    if (!api) return;

    if (preparedConsentState !== 'prepared') {
      setLastResult('Prepare consent before starting');
      return;
    }

    setLastFilePath(undefined);
    setLastResult('Starting from prepared consent...');
    api.startGlobalRecording({
      options: {
        enableMic,
        usePreparedConsent: true,
      },
      onRecordingError: (error) => {
        refreshPreparedConsentState();
        setLastResult(`Start failed: ${error.message}`);
        console.log('Prepared global recording error', error);
      },
    });
    setPreparedConsentState('recording');
    setIsPreparedConsentGranted(false);
    setLastResult('Prepared recording started');
  };

  const handleStopPreparedGlobalRecording = async () => {
    try {
      setLastResult('Stopping prepared recording...');
      const file = await ScreenRecorder.stopGlobalRecording({
        settledTimeMs: 1000,
      });
      refreshPreparedConsentState();
      setLastFilePath(file?.path);
      setLastResult(file ? 'Prepared recording stopped' : 'No file returned');
    } catch (error) {
      refreshPreparedConsentState();
      setLastResult(`Stop failed: ${getErrorMessage(error)}`);
      logError('Prepared recording stop failed:', error);
    }
  };

  const canPrepare = preparedConsentState === 'idle';
  const canStart = preparedConsentState === 'prepared';
  const canStop = preparedConsentState === 'recording';
  const canRelease = preparedConsentState === 'prepared';

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Prepared Consent (Android)</Text>
      <View style={styles.statusGrid}>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>Session</Text>
          <Text style={styles.statusValue}>{preparedConsentState}</Text>
        </View>
        <View style={styles.statusItem}>
          <Text style={styles.statusLabel}>Consent</Text>
          <Text style={styles.statusValue}>
            {isPreparedConsentGranted ? 'granted' : 'not granted'}
          </Text>
        </View>
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.permissionLabel}>Microphone</Text>
        <Switch
          accessibilityLabel="Microphone"
          value={enableMic}
          onValueChange={setEnableMic}
        />
      </View>
      <View style={styles.buttonRow}>
        <View style={styles.buttonContainer}>
          <Button
            title="Prepare"
            onPress={handleRequestScreenRecordingConsent}
            color="#007AFF"
            disabled={!canPrepare}
          />
        </View>
        <View style={styles.buttonContainer}>
          <Button
            title="Refresh"
            onPress={refreshPreparedConsentState}
            color="#5856D6"
          />
        </View>
      </View>
      <View style={styles.buttonRow}>
        <View style={styles.buttonContainer}>
          <Button
            title="Start Prepared"
            onPress={handleStartPreparedGlobalRecording}
            color="#34C759"
            disabled={!canStart}
          />
        </View>
        <View style={styles.buttonContainer}>
          <Button
            title="Stop Prepared"
            onPress={handleStopPreparedGlobalRecording}
            color="#FF9500"
            disabled={!canStop}
          />
        </View>
      </View>
      <View style={styles.buttonRow}>
        <View style={styles.buttonContainer}>
          <Button
            title="Release"
            onPress={handleReleaseScreenRecordingConsent}
            color="#FF3B30"
            disabled={!canRelease}
          />
        </View>
      </View>
      <Text style={styles.resultLabel}>Last Result</Text>
      <Text style={styles.resultValue}>{lastResult}</Text>
      {lastFilePath ? (
        <>
          <Text style={styles.resultLabel}>Latest File</Text>
          <Text style={styles.filePath}>{lastFilePath}</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1C1C1E',
    marginBottom: 12,
    textAlign: 'center',
  },
  permissionLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#3C3C43',
    marginTop: 8,
    marginBottom: 4,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  buttonContainer: {
    flex: 1,
    marginHorizontal: 4,
  },
  statusGrid: {
    flexDirection: 'row',
    marginBottom: 8,
  },
  statusItem: {
    flex: 1,
    backgroundColor: '#F2F2F7',
    borderRadius: 8,
    marginHorizontal: 4,
    padding: 10,
  },
  statusLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#8E8E93',
    marginBottom: 4,
  },
  statusValue: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1C1E',
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginHorizontal: 4,
  },
  resultLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8E8E93',
    marginHorizontal: 4,
    marginTop: 8,
  },
  resultValue: {
    color: '#1C1C1E',
    fontSize: 14,
    marginHorizontal: 4,
    marginTop: 4,
  },
  filePath: {
    color: '#3C3C43',
    fontSize: 12,
    marginHorizontal: 4,
    marginTop: 4,
  },
});
