import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: process.env.CODEVIA_BUNDLE_ID ?? 'com.codevia.pocket',
  appName: 'Codevia Pocket',
  webDir: 'dist',
  ios: {
    contentInset: 'never',
    scheme: 'Codevia Pocket',
    backgroundColor: '#0c0e12',
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    Keyboard: { resize: KeyboardResize.Native, resizeOnFullScreen: true },
    SplashScreen: { launchShowDuration: 400, backgroundColor: '#0c0e12', showSpinner: false },
    StatusBar: { style: 'DARK', backgroundColor: '#0c0e12', overlaysWebView: true },
  },
};

export default config;
