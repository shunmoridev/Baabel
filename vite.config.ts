import { defineConfig } from 'vite';
import { thirdPartyLicenses } from './scripts/third-party-licenses.ts';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  plugins: [thirdPartyLicenses({ header: 'Baabel (MIT, see LICENSE) bundles the following third-party software.' })],
});
