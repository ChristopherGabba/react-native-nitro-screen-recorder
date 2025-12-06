export interface ConfigProps {
    /**
     * Whether to enable camera permission for screen recording with camera overlay.
     *
     * @platform iOS
     * @default true
     * @example true
     */
    enableCameraPermission?: boolean;
    /**
     * Camera permission description text displayed in iOS permission dialog.
     * This text explains why the app needs camera access for screen recording features.
     *
     * @platform iOS
     * @default "Allow $(PRODUCT_NAME) to access your camera for screen recording with camera overlay"
     * @example "This app needs camera access to include your camera feed in screen recordings"
     */
    cameraPermissionText?: string;
    /**
     * Whether to enable microphone permission for screen recording with audio capture.
     *
     * @platform iOS, Android
     * @default true
     * @example false
     */
    enableMicrophonePermission?: boolean;
    /**
     * Microphone permission description text displayed in iOS permission dialog.
     * This text explains why the app needs microphone access for audio recording.
     *
     * @platform iOS
     * @default "Allow $(PRODUCT_NAME) to access your microphone for screen recording with audio"
     * @example "This app needs microphone access to record audio during screen capture"
     */
    microphonePermissionText?: string;
    /**
     * Provies a means for customizing the ios broadcast extension target name.
     * @default: `BroadcastExtension`
     */
    iosBroadcastExtensionTargetName?: string;
    /**
     * Provies a means for customizing your app group identifier.
     */
    iosAppGroupIdentifier?: string;
    /**
     * Provies a means for customizing the ios broadcast extension bundle identifier.
     */
    iosExtensionBundleIdentifier?: string;
    /**
     * Whether to display detailed plugin logs during the build process.
     * Useful for debugging configuration issues during development.
     *
     * @platform iOS, Android
     * @default false
     * @example true
     */
    showPluginLogs?: boolean;
}
