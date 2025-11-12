# Changelog

## [Unreleased]
### Added
- MP4 faststart support for streaming-friendly video files on both iOS and Android
- iOS: Set `shouldOptimizeForNetworkUse = true` on AVAssetWriter to place moov atom at beginning of file
- Android: Embedded QtFastStart implementation for MP4 optimization without external dependencies

### Fixed
- Videos can now be streamed progressively and processed through FFmpeg streams/pipes without requiring disk access to read metadata
- Improves compatibility with video streaming platforms and progressive playback
- moov atom is now correctly placed at the beginning of MP4 files for optimal streaming performance

## [0.5.0] - 2025-10-30
### Fixed
- #13 remove retroactive for swift 5 error
- Bump nitro modules version

### Added
- Add warning on iOS app group identifier name

## [0.4.8] - 2025-10-20
### Chore
- Bump nitro modules version

## [0.4.7] - 2025-10-06
### Fixed
- Fix expo config plugin issues

## [0.4.3] - 2025-10-05
### Fixed
- Fix expo config plugin problems

## [0.3.10] - 2025-09-25
### Chore
- Bump dependencies (nitro-modules, expo, etc.)

## [0.3.9] - 2025-09-09
### Fixed
- Build regression on iOS

## [0.3.8] - 2025-09-8
### Changes
- Fix #9, privacyinfo naming conflict with other expo config plugins

## [0.3.7] - 2025-08-25
### Changes
- Bump nitro modules to 0.29.3 (latest)
- Fix Gradle Build error

## [0.3.6] - 2025-08-25
### Changes
- Bump nitro modules to 0.29.2 (latest)

## [0.3.5] - 2025-08-25
### Changes
- Bump nitro modules to 0.28.1 (latest)

## [0.3.4] - 2025-08-12
### Changes
- Fix expo plugin typescript
- Allow customizing the screen recorder target name on iOS
- Bump nitro modules to 0.28.0 (latest)

## [0.3.2] - 2025-08-12
### Changes
- Fix expo plugin typescript
- Close #7 - ignore external screen recording property to the useGlobalRecording hook
- Bump nitro modules to 0.27.6 (latest)

## [0.2.8] - 2025-08-02
### Feat
- Allow custom iosBundleIdentifier for BroadcastExtension

## [0.2.7] - 2025-08-02
### Feat
- Rewrite `useGlobalRecording` hook
- Add adjustable `settledTimeMs` to `stopGlobalRecording` function

### Chore
- Update README.md
- Bump react-native-nitro-modules to 0.27.3
- Update keywords on package.json

## [0.1.9] - [0.2.5] - 2025-08-02
### Fix
- Rewrite of app group entitlements file, wasn't applying correctly to the main app

## [0.1.8] - 2025-08-02
### Fix
- Complete rewrite of config plugin to make files link properly on ios
- Successful hack to get stopGlobalRecording work on iOS
- Fix multiple bugs on iOS

## [0.1.6] - 2025-07-31
### Fix
- Attempt #6: Fix build error with expo config plugin

## [0.1.5] - 2025-07-31
### Fix
- Attempt #5: Fix build error with expo config plugin

## [0.1.4] - 2025-07-31
### Fix
- Attempt #4: Fix build error with expo config plugin

## [0.1.3] - 2025-07-31
### Fix
- Attempt #3: Typescript error in expo config plugin

## [0.1.2] - 2025-07-31
### Fix
- Attempt #2: Typescript error in expo config plugin

## [0.1.1] - 2025-07-30
### Fix
- Typescript error in expo config plugin

## [0.1.0] - 2025-07-30
### Added
- Initial release
