// updatePodfile.ts
import fs from 'fs';
import {
  getBroadcastExtensionPodfileSnippet,
  getBroadcastExtensionTargetName,
} from './iosConstants';
import { ScreenRecorderLog } from './ScreenRecorderLog';
import { FileManager } from './FileManager';
import type { ConfigProps } from '../@types';

export async function updatePodfile(iosPath: string, props: ConfigProps) {
  const podfilePath = `${iosPath}/Podfile`;
  let podfile = await FileManager.readFile(podfilePath);

  // Skip if already present
  if (podfile.includes(getBroadcastExtensionTargetName(props))) {
    ScreenRecorderLog.log('Extension target already in Podfile. Skipping…');
    return;
  }

  // Inject snippet into every `target 'Something' do … end` that looks like an iOS app
  podfile = podfile.replace(/target ['"][^'"]+['"] do([\s\S]*?)end/g, (block) =>
    block.replace(
      /\nend$/,
      `${getBroadcastExtensionPodfileSnippet(props)}\nend`
    )
  );

  await fs.promises.writeFile(podfilePath, podfile, 'utf8');
  ScreenRecorderLog.log('Inserted BroadcastExtension into Podfile.');
}
