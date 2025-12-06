export class ScreenRecorderLog {
  private static readonly PLUGIN = 'react-native-nitro-screen-recorder';

  static log(message: string, ...optional: any[]) {
    const green = '\x1b[32m';
    const reset = '\x1b[0m';
    console.log(`${green}[${this.PLUGIN}]${reset} ${message}`, ...optional);
  }

  static error(message: string, ...optional: any[]) {
    const red = '\x1b[31m';
    const reset = '\x1b[0m';
    console.error(`${red}[${this.PLUGIN}]${reset} ${message}`, ...optional);
  }
}
