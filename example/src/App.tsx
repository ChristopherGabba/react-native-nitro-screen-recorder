import {
  View,
  StyleSheet,
  Button,
  Text,
  ScrollView,
  Platform,
} from 'react-native';
import * as ScreenRecorder from '../../src';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { getVideoInfoAsync } from 'expo-video-metadata';
import { PreparedConsentSection } from './PreparedConsentSection';

export default function App() {
  const [inAppRecording, setInAppRecording] = useState<
    ScreenRecorder.ScreenRecordingFile | undefined
  >();

  const [globalRecording, setGlobalRecording] = useState<
    ScreenRecorder.ScreenRecordingFile | undefined
  >();

  const { isRecording } = ScreenRecorder.useGlobalRecording({
    onRecordingStarted: () => {
      console.log('Recording started');
    },
    onRecordingFinished: () => {
      console.log('Recording ended');
    },
    onBroadcastModalShown: () => {
      console.log('Modal showing');
    },
    onBroadcastModalDismissed: () => {
      console.log('Modal dismissed');
    },
  });
  // @ts-ignore
  const inAppPlayer = useVideoPlayer(inAppRecording?.path);
  // @ts-ignore
  const globalPlayer = useVideoPlayer(globalRecording?.path);

  // Permission Functions
  const getCameraPermissionStatus = () => {
    console.log('CAMERA STATUS:', ScreenRecorder.getCameraPermissionStatus());
  };

  const getMicrophonePermissionStatus = () => {
    console.log('MIC STATUS:', ScreenRecorder.getMicrophonePermissionStatus());
  };

  const requestCameraPermission = () => {
    ScreenRecorder.requestCameraPermission().then((status) => {
      console.log('Received Camera Status:', JSON.stringify(status, null, 2));
    });
  };

  const requestMicrophonePermission = () => {
    ScreenRecorder.requestMicrophonePermission().then((status) => {
      console.log('Received Mic Status:', JSON.stringify(status, null, 2));
    });
  };

  // Recording Options
  const options: ScreenRecorder.InAppRecordingOptions = {
    enableMic: true,
    enableCamera: true,
    cameraPreviewStyle: {
      width: 150,
      height: 200,
      top: 30,
      left: 20,
      borderRadius: 10,
    },
    cameraDevice: 'back',
  };

  // In-App Recording Functions
  const handleStartInAppRecording = async () => {
    try {
      await ScreenRecorder.startInAppRecording({
        options,
        onRecordingFinished(file) {
          console.log(
            'In-app recording finished:',
            JSON.stringify(file, null, 2)
          );
          setInAppRecording(file);
        },
      });
    } catch (error) {
      console.error('❌ Error starting recording:', error);
    }
  };

  const handleStopInAppRecording = () => {
    ScreenRecorder.stopInAppRecording();
  };

  const handleCancelInAppRecording = () => {
    ScreenRecorder.cancelInAppRecording();
    console.log('In-app recording cancelled');
  };

  // Global Recording Functions
  const handleStartGlobalRecording = () => {
    ScreenRecorder.startGlobalRecording({
      options: {
        enableMic: true,
      },
      onRecordingError: (error) => {
        console.log('Global recording error', error);
      },
    });
  };

  const checkFileAccessibility = async (
    file: ScreenRecorder.ScreenRecordingFile | undefined
  ) => {
    if (file) {
      try {
        console.log('Checking file accessibility for path', file.path);
        const data = await getVideoInfoAsync(file.path);
        console.log(JSON.stringify(data, null, 2));
      } catch (error) {
        console.error('Error', error);
      }
    }
  };

  const handleStopGlobalRecording = async () => {
    const newFile = await ScreenRecorder.stopGlobalRecording();
    setGlobalRecording(newFile);
    await checkFileAccessibility(newFile);
  };

  const handleGetGlobalRecordingFile = async () => {
    const newFile = ScreenRecorder.retrieveLastGlobalRecording();
    setGlobalRecording(newFile);
    await checkFileAccessibility(newFile);
  };

  const handleClearRecordingCache = () => {
    ScreenRecorder.clearCache();
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.contentContainer}
    >
      {/* Permissions Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Permissions</Text>
        {Platform.OS === 'ios' && (
          <>
            <Text style={styles.permissionLabel}>Camera</Text>
            <View style={styles.buttonRow}>
              <View style={styles.buttonContainer}>
                <Button
                  title="Check Camera"
                  onPress={getCameraPermissionStatus}
                  color="#007AFF"
                />
              </View>
              <View style={styles.buttonContainer}>
                <Button
                  title="Request Camera"
                  onPress={requestCameraPermission}
                  color="#007AFF"
                />
              </View>
            </View>
          </>
        )}

        <Text style={styles.permissionLabel}>Microphone</Text>
        <View style={styles.buttonRow}>
          <View style={styles.buttonContainer}>
            <Button
              title="Check Microphone"
              onPress={getMicrophonePermissionStatus}
              color="#007AFF"
            />
          </View>
          <View style={styles.buttonContainer}>
            <Button
              title="Request Microphone"
              onPress={requestMicrophonePermission}
              color="#007AFF"
            />
          </View>
        </View>
      </View>

      {/* In-App Recording Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>In-App Recording</Text>
        <View style={styles.buttonRow}>
          <View style={styles.buttonContainer}>
            <Button
              title="Start Recording"
              onPress={handleStartInAppRecording}
              color="#34C759"
            />
          </View>
          <View style={styles.buttonContainer}>
            <Button
              title="Stop Recording"
              onPress={handleStopInAppRecording}
              color="#FF3B30"
            />
          </View>
          <View style={styles.buttonContainer}>
            <Button
              title="Cancel Recording"
              onPress={handleCancelInAppRecording}
              color="#FF9500"
            />
          </View>
        </View>
        <Text style={styles.playerLabel}>In-App Recording Player</Text>
        <VideoView player={inAppPlayer} style={styles.player} />
      </View>

      <PreparedConsentSection />

      {/* Global Recording Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Global Recording</Text>
        <View style={styles.buttonRow}>
          {!isRecording ? (
            <View style={styles.buttonContainer}>
              <Button
                title="Start Global"
                onPress={handleStartGlobalRecording}
                color="#34C759"
              />
            </View>
          ) : (
            <View style={styles.buttonContainer}>
              <Button
                title="Stop Global"
                onPress={handleStopGlobalRecording}
                color="#FF3B30"
              />
            </View>
          )}
          <View style={styles.buttonContainer}>
            <Button
              title="Get Latest File"
              onPress={handleGetGlobalRecordingFile}
              color="#FF9500"
            />
          </View>
        </View>
        <Text style={styles.playerLabel}>Global Recording Player</Text>
        <VideoView player={globalPlayer} style={styles.player} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Clear Cache</Text>
        <View style={styles.buttonRow}>
          <View style={styles.buttonContainer}>
            <Button
              title="Clear Recording Cache"
              onPress={handleClearRecordingCache}
              color="#FF3B30"
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F2F2F7',
  },
  contentContainer: {
    paddingTop: 32,
    padding: 16,
    paddingBottom: 32,
  },
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
  loading: {
    width: '100%',
    textAlign: 'center',
  },
  playerLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#8E8E93',
    marginTop: 12,
    marginBottom: 4,
  },
  player: {
    backgroundColor: '#E5E5EA',
    height: 200,
    width: '100%',
    borderRadius: 8,
    marginTop: 8,
  },
});
