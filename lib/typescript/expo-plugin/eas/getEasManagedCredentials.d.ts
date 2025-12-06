import type { ConfigProps } from '../@types';
import type { ExpoConfig } from '@expo/config-types';
export default function getEasManagedCredentialsConfigExtra(config: ExpoConfig, props: ConfigProps): {
    [k: string]: any;
};
