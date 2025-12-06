"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withAndroidScreenRecording = void 0;
const config_plugins_1 = require("@expo/config-plugins");
const ScreenRecorderLog_1 = require("../support/ScreenRecorderLog");
const withAndroidScreenRecording = (config) => {
    // Add permissions and services to AndroidManifest.xml
    config = (0, config_plugins_1.withAndroidManifest)(config, (mod) => {
        var _a;
        ScreenRecorderLog_1.ScreenRecorderLog.log('Adding screen recording permissions and services to AndroidManifest.xml');
        const androidManifest = mod.modResults;
        if (!((_a = androidManifest.manifest.application) === null || _a === void 0 ? void 0 : _a[0])) {
            throw new Error('Cannot find <application> in AndroidManifest.xml');
        }
        const application = androidManifest.manifest.application[0];
        if (!application.service) {
            application.service = [];
        }
        // Add only the Global ScreenRecordingService
        const serviceName = 'com.margelo.nitro.nitroscreenrecorder.ScreenRecordingService';
        const existingService = application.service.find((service) => { var _a; return ((_a = service.$) === null || _a === void 0 ? void 0 : _a['android:name']) === serviceName; });
        if (!existingService) {
            application.service.push({
                $: {
                    'android:name': serviceName,
                    'android:enabled': 'true',
                    'android:exported': 'false',
                    'android:foregroundServiceType': 'mediaProjection',
                },
            });
            ScreenRecorderLog_1.ScreenRecorderLog.log(`✅ Added Global ScreenRecordingService to AndroidManifest.xml`);
        }
        else {
            ScreenRecorderLog_1.ScreenRecorderLog.log(`ℹ️ Global ScreenRecordingService already exists in AndroidManifest.xml`);
        }
        return mod;
    });
    // Modify MainActivity to handle activity results (still needed for Global Recording)
    config = (0, config_plugins_1.withMainActivity)(config, (mod) => {
        ScreenRecorderLog_1.ScreenRecorderLog.log('Modifying MainActivity for screen recording activity results');
        const { modResults } = mod;
        let mainActivityContent = modResults.contents;
        const isKotlin = mainActivityContent.includes('class MainActivity') &&
            (mainActivityContent.includes('override fun') ||
                mainActivityContent.includes('kotlin'));
        if (isKotlin) {
            mainActivityContent =
                addKotlinScreenRecordingSupport(mainActivityContent);
        }
        else {
            mainActivityContent = addJavaScreenRecordingSupport(mainActivityContent);
        }
        modResults.contents = mainActivityContent;
        return mod;
    });
    return config;
};
exports.withAndroidScreenRecording = withAndroidScreenRecording;
// This function remains unchanged as it's still needed for Global Recording
function addKotlinScreenRecordingSupport(content) {
    // Required imports
    const requiredImports = [
        'import com.margelo.nitro.nitroscreenrecorder.NitroScreenRecorder',
        'import android.content.Intent',
        'import android.util.Log',
    ];
    // Add imports if not present
    requiredImports.forEach((importStatement) => {
        if (!content.includes(importStatement)) {
            const importRegex = /(import\s+.*\n)/g;
            let lastImportMatch;
            let match;
            while ((match = importRegex.exec(content)) !== null) {
                lastImportMatch = match;
            }
            if (lastImportMatch) {
                const insertPosition = lastImportMatch.index + lastImportMatch[0].length;
                content =
                    content.slice(0, insertPosition) +
                        importStatement +
                        '\n' +
                        content.slice(insertPosition);
            }
        }
    });
    // Add onActivityResult method if not present
    if (!content.includes('onActivityResult')) {
        const classEndRegex = /(\s*)\}(\s*)$/;
        const match = content.match(classEndRegex);
        if (match && match.index !== undefined) {
            const onActivityResultMethod = `
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    Log.d("MainActivity", "onActivityResult: requestCode=$requestCode, resultCode=$resultCode")
    
    try {
      // Handle screen recording activity results
      NitroScreenRecorder.handleActivityResult(requestCode, resultCode, data)
    } catch (e: Exception) {
      Log.e("MainActivity", "Error handling activity result: \${e.message}")
      e.printStackTrace()
    }
  }
`;
            const insertPosition = match.index;
            content =
                content.slice(0, insertPosition) +
                    onActivityResultMethod +
                    content.slice(insertPosition);
            ScreenRecorderLog_1.ScreenRecorderLog.log('✅ Added onActivityResult method to Kotlin MainActivity');
        }
    }
    else {
        if (!content.includes('NitroScreenRecorder.handleActivityResult')) {
            const onActivityResultRegex = /(override\s+fun\s+onActivityResult\s*\([^)]*\)\s*\{[^}]*)(super\.onActivityResult[^}]*)/;
            const match = content.match(onActivityResultRegex);
            if (match && match[1] && match[2]) {
                const screenRecordingHandler = `
    
    try {
      // Handle screen recording activity results
      NitroScreenRecorder.handleActivityResult(requestCode, resultCode, data)
    } catch (e: Exception) {
      Log.e("MainActivity", "Error handling activity result: \${e.message}")
      e.printStackTrace()
    }`;
                content = content.replace(onActivityResultRegex, match[1] + match[2] + screenRecordingHandler);
                ScreenRecorderLog_1.ScreenRecorderLog.log('✅ Added screen recording handler to existing onActivityResult method');
            }
        }
        else {
            ScreenRecorderLog_1.ScreenRecorderLog.log('ℹ️ Screen recording handler already exists in onActivityResult method');
        }
    }
    return content;
}
// This function remains unchanged as it's still needed for Global Recording
function addJavaScreenRecordingSupport(content) {
    const requiredImports = [
        'import android.content.Intent;',
        'import com.margelo.nitro.nitroscreenrecorder.NitroScreenRecorder;',
        'import android.util.Log;',
    ];
    requiredImports.forEach((importStatement) => {
        if (!content.includes(importStatement)) {
            const importRegex = /(import\s+.*;\s*\n)/g;
            let lastImportMatch;
            let match;
            while ((match = importRegex.exec(content)) !== null) {
                lastImportMatch = match;
            }
            if (lastImportMatch) {
                const insertPosition = lastImportMatch.index + lastImportMatch[0].length;
                content =
                    content.slice(0, insertPosition) +
                        importStatement +
                        '\n' +
                        content.slice(insertPosition);
            }
        }
    });
    if (!content.includes('onActivityResult')) {
        const classEndRegex = /(\s*)\}(\s*)$/;
        const match = content.match(classEndRegex);
        if (match && match.index !== undefined) {
            const onActivityResultMethod = `
  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);
    Log.d("MainActivity", "onActivityResult: requestCode=" + requestCode + ", resultCode=" + resultCode);
    
    try {
      // Handle screen recording activity results
      NitroScreenRecorder.handleActivityResult(requestCode, resultCode, data);
    } catch (Exception e) {
      Log.e("MainActivity", "Error handling activity result: " + e.getMessage());
      e.printStackTrace();
    }
  }
`;
            const insertPosition = match.index;
            content =
                content.slice(0, insertPosition) +
                    onActivityResultMethod +
                    content.slice(insertPosition);
            ScreenRecorderLog_1.ScreenRecorderLog.log('✅ Added onActivityResult method to Java MainActivity');
        }
    }
    else {
        if (!content.includes('NitroScreenRecorder.handleActivityResult')) {
            const onActivityResultRegex = /(@Override\s+public\s+void\s+onActivityResult\s*\([^)]*\)\s*\{[^}]*)(super\.onActivityResult[^}]*)/;
            const match = content.match(onActivityResultRegex);
            if (match && match[1] && match[2]) {
                const screenRecordingHandler = `
    
    try {
      // Handle screen recording activity results
      NitroScreenRecorder.handleActivityResult(requestCode, resultCode, data);
    } catch (Exception e) {
      Log.e("MainActivity", "Error handling activity result: " + e.getMessage());
      e.printStackTrace();
    }`;
                content = content.replace(onActivityResultRegex, match[1] + match[2] + screenRecordingHandler);
                ScreenRecorderLog_1.ScreenRecorderLog.log('✅ Added screen recording handler to existing onActivityResult method');
            }
        }
        else {
            ScreenRecorderLog_1.ScreenRecorderLog.log('ℹ️ Screen recording handler already exists in onActivityResult method');
        }
    }
    return content;
}
