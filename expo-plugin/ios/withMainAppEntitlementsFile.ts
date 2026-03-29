import { type ConfigPlugin, withXcodeProject } from '@expo/config-plugins';
import { type ConfigProps } from '../@types';
import { ScreenRecorderLog } from '../support/ScreenRecorderLog';

const getNormalizedString = (value: unknown) => {
  return typeof value === 'string' ? value.replace(/"/g, '') : undefined;
};

const getChildReferenceKey = (child: unknown) => {
  if (typeof child === 'string') {
    return child;
  }

  const isChildObject = typeof child === 'object' && child !== null;

  if (!isChildObject) {
    return undefined;
  }

  return typeof (child as { value?: unknown }).value === 'string'
    ? (child as { value: string }).value
    : undefined;
};

const getMainAppEntitlementsPath = (
  xcodeProject: any,
  fallbackGroupName: string,
  fallbackEntitlementsFileName: string
) => {
  const configurations = xcodeProject.pbxXCBuildConfigurationSection();

  for (const key in configurations) {
    const config = configurations[key];
    const buildSettings = config.buildSettings;

    if (!buildSettings) {
      continue;
    }

    const productName = getNormalizedString(buildSettings.PRODUCT_NAME);
    const isExtensionProduct =
      !!productName &&
      (productName.includes('Extension') || productName.includes('Widget'));

    if (isExtensionProduct) {
      continue;
    }

    const codeSignEntitlements = getNormalizedString(
      buildSettings.CODE_SIGN_ENTITLEMENTS
    );

    if (codeSignEntitlements) {
      return codeSignEntitlements;
    }
  }

  return `${fallbackGroupName}/${fallbackEntitlementsFileName}`;
};

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
    const files = xcodeProject.hash.project.objects.PBXFileReference;
    const groups = xcodeProject.hash.project.objects.PBXGroup;
    let mainAppGroupKey: string | null = null;
    let mainAppGroupName: string | null = null;

    ScreenRecorderLog.log('Available groups:');
    for (const key in groups) {
      const group = groups[key];
      if (group && group.name) {
        ScreenRecorderLog.log(`  - ${group.name} (key: ${key})`);
      }
    }

    const normalizedProjectName = projectName.replace(/\s/g, '');
    const searchNames = [
      projectName,
      normalizedProjectName,
      `${projectName}/`,
      `${normalizedProjectName}/`,
    ];

    for (const searchName of searchNames) {
      for (const key in groups) {
        const group = groups[key];
        const groupName = getNormalizedString(group?.name);
        const groupPath = getNormalizedString(group?.path);
        const hasMatchedGroup =
          groupName === searchName || groupPath === searchName;

        if (group && hasMatchedGroup) {
          mainAppGroupKey = key;
          mainAppGroupName = groupPath ?? groupName;
          ScreenRecorderLog.log(
            `Found main app group with name: ${searchName}`
          );
          break;
        }
      }
      if (mainAppGroupKey) break;
    }

    // If still not found, try to find the group that contains AppDelegate or main source files
    if (!mainAppGroupKey) {
      ScreenRecorderLog.log(
        'Trying to find main app group by looking for AppDelegate...'
      );

      for (const key in groups) {
        const group = groups[key];

        if (group && group.children) {
          const hasMainAppFiles = group.children.some((childKey: unknown) => {
            const childReferenceKey = getChildReferenceKey(childKey);
            const isChildReferenceKeyUndefined =
              typeof childReferenceKey === 'undefined';

            if (isChildReferenceKeyUndefined) {
              return false;
            }

            const file = files[childReferenceKey];

            return (
              file &&
              (file.path?.includes('AppDelegate') ||
                file.path?.includes('Info.plist') ||
                file.name?.includes('AppDelegate'))
            );
          });

          if (hasMainAppFiles) {
            mainAppGroupKey = key;
            const groupName = getNormalizedString(group.name);
            const groupPath = getNormalizedString(group.path);
            mainAppGroupName = groupPath ?? groupName;
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

    const resolvedMainAppGroupName = mainAppGroupName ?? normalizedProjectName;
    const entitlementsFileName = `${resolvedMainAppGroupName}.entitlements`;
    const entitlementsPath = getMainAppEntitlementsPath(
      xcodeProject,
      resolvedMainAppGroupName,
      entitlementsFileName
    );

    const entitlementsFileExists = Object.values(files).some((file: any) => {
      const filePath = getNormalizedString(file?.path);
      const fileName = getNormalizedString(file?.name);

      return (
        filePath === entitlementsPath ||
        filePath === entitlementsFileName ||
        fileName === entitlementsFileName
      );
    });

    if (entitlementsFileExists) {
      ScreenRecorderLog.log(
        `${entitlementsFileName} already exists in project. Skipping...`
      );
      return newConfig;
    }

    try {
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
