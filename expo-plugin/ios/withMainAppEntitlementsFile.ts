import { type ConfigPlugin, withXcodeProject } from '@expo/config-plugins';
import { type ConfigProps } from '../@types';
import { ScreenRecorderLog } from '../support/ScreenRecorderLog';

/**
 * Add the main app's entitlements file to the Xcode project navigator
 * This ensures the .entitlements file is visible in Xcode's file tree
 */
export const withMainAppEntitlementsFile: ConfigPlugin<ConfigProps> = (
  config
) => {
  return withXcodeProject(config, (newConfig) => {
    const xcodeProject = newConfig.modResults;
    const projectName = newConfig.name;
    const entitlementsFileName = `${projectName}.entitlements`;
    const entitlementsPath = `${projectName}/${entitlementsFileName}`;

    // Check if the entitlements file is already added to the project
    const files = xcodeProject.hash.project.objects.PBXFileReference;

    // Safety check: ensure files object exists
    if (!files) {
      ScreenRecorderLog.log(
        'PBXFileReference not found in project. Skipping entitlements file addition.'
      );
      return newConfig;
    }

    const entitlementsFileExists = Object.values(files).some(
      (file: any) => file && file.path === `"${entitlementsFileName}"`
    );

    if (entitlementsFileExists) {
      ScreenRecorderLog.log(
        `${entitlementsFileName} already exists in project. Skipping...`
      );
      return newConfig;
    }

    // Find the main app group (try multiple approaches)
    const groups = xcodeProject.hash.project.objects.PBXGroup;
    let mainAppGroupKey: string | null = null;

    // Debug: log all group names to understand the structure
    ScreenRecorderLog.log('Available groups:');
    for (const key in groups) {
      const group = groups[key];
      if (group && group.name) {
        ScreenRecorderLog.log(`  - ${group.name} (key: ${key})`);
      }
    }

    // Try different variations of the project name
    const searchNames = [
      `"${projectName}"`, // Quoted version
      projectName, // Unquoted version
      `"${projectName}/"`, // With trailing slash
      `${projectName}/`, // Unquoted with trailing slash
    ];

    for (const searchName of searchNames) {
      for (const key in groups) {
        const group = groups[key];
        if (group && group.name === searchName) {
          mainAppGroupKey = key;
          ScreenRecorderLog.log(
            `Found main app group with name: ${searchName}`
          );
          break;
        }
      }
      if (mainAppGroupKey) break;
    }

    // If still not found, try to find the group that contains AppDelegate or main source files
    if (!mainAppGroupKey && files) {
      ScreenRecorderLog.log(
        'Trying to find main app group by looking for AppDelegate...'
      );
      for (const key in groups) {
        const group = groups[key];
        if (group && group.children && Array.isArray(group.children)) {
          // Check if this group contains typical main app files
          const hasMainAppFiles = group.children.some((childKey: string) => {
            // Safety check: ensure childKey is a valid string
            if (!childKey || typeof childKey !== 'string') {
              return false;
            }
            const file = files[childKey];
            return (
              file &&
              (file.path?.includes('AppDelegate') ||
                file.path?.includes('Info.plist') ||
                file.name?.includes('AppDelegate'))
            );
          });

          if (hasMainAppFiles) {
            mainAppGroupKey = key;
            ScreenRecorderLog.log(
              `Found main app group by AppDelegate: ${group.name || 'unnamed'}`
            );
            break;
          }
        }
      }
    }

    if (!mainAppGroupKey) {
      ScreenRecorderLog.log(
        `Could not find main app group for ${projectName}. Available groups logged above.`
      );
      return newConfig;
    }

    // Add the entitlements file to the project
    try {
      // Create the file reference
      const fileRef = xcodeProject.addFile(entitlementsPath, mainAppGroupKey, {
        lastKnownFileType: 'text.plist.entitlements',
        defaultEncoding: 4,
        target: undefined,
      });

      if (fileRef) {
        ScreenRecorderLog.log(
          `Successfully added ${entitlementsFileName} to Xcode project navigator`
        );
      }
    } catch (error) {
      ScreenRecorderLog.log(
        `Error adding entitlements file to project: ${error}`
      );
    }

    return newConfig;
  });
};
