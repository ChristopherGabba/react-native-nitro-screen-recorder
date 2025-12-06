import { type ConfigProps } from '../@types';
import { FileManager } from './FileManager';
import {
  BUNDLE_SHORT_VERSION_TEMPLATE_REGEX,
  BUNDLE_VERSION_TEMPLATE_REGEX,
  getBroadcastExtensionTargetName,
  GROUP_IDENTIFIER_TEMPLATE_REGEX,
} from './iosConstants';

// project `ios/${BROADCAST_EXT_TARGET_NAME}` directory
const entitlementsFileName = `BroadcastExtension.entitlements`;
const plistFileName = `BroadcastExtension-Info.plist`;

export default class BEUpdaterManager {
  private extensionPath = '';

  constructor(iosPath: string, props: ConfigProps) {
    const targetName = getBroadcastExtensionTargetName(props);
    this.extensionPath = `${iosPath}/${targetName}`;
  }

  /**
   * Injects the real App Group identifier into the entitlements file so the
   * Broadcast Upload Extension can share storage with the main app.
   */
  async updateEntitlements(groupIdentifier: string): Promise<void> {
    const entitlementsFilePath = `${this.extensionPath}/${entitlementsFileName}`;
    let entitlementsFile = await FileManager.readFile(entitlementsFilePath);

    entitlementsFile = entitlementsFile.replace(
      GROUP_IDENTIFIER_TEMPLATE_REGEX,
      groupIdentifier
    );

    await FileManager.writeFile(entitlementsFilePath, entitlementsFile);
  }

  /**
   * Makes CFBundleVersion of the Broadcast Extension match the host app’s
   * build number to avoid App Store validation errors.
   */
  async updateInfoPlist(
    version: string,
    groupIdentifier: string
  ): Promise<void> {
    const plistFilePath = `${this.extensionPath}/${plistFileName}`;
    let plistFile = await FileManager.readFile(plistFilePath);

    plistFile = plistFile
      .replace(BUNDLE_VERSION_TEMPLATE_REGEX, version)
      .replace(GROUP_IDENTIFIER_TEMPLATE_REGEX, groupIdentifier);

    await FileManager.writeFile(plistFilePath, plistFile);
  }

  /**
   * Syncs CFBundleShortVersionString (marketing version) with the main app so
   * TestFlight/App Store show a single coherent version.
   */
  async updateBundleShortVersion(version: string): Promise<void> {
    const plistFilePath = `${this.extensionPath}/${plistFileName}`;
    let plistFile = await FileManager.readFile(plistFilePath);

    plistFile = plistFile.replace(BUNDLE_SHORT_VERSION_TEMPLATE_REGEX, version);

    await FileManager.writeFile(plistFilePath, plistFile);
  }
}
