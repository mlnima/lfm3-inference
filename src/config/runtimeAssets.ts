import type { RuntimeAsset } from './types.js';

export const runtimeVersion = 'b11960';

export const runtimeAssets: Record<string, RuntimeAsset[]> = {
  'win32-x64': [
    {
      name: 'llama-b11960-bin-win-cuda-12.4-x64.zip',
      sha256: '8d9d819261de10cc2f03921b8b79c779c5c458e21edb60c170ee30a7d462d684',
    },
    {
      name: 'cudart-llama-bin-win-cuda-12.4-x64.zip',
      sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    },
  ],
  'linux-x64': [
    {
      name: 'llama-b11960-bin-ubuntu-cuda-12.8-x64.tar.gz',
      sha256: '64d57beb9abb637c177c6afb313760a0c0782224cac71e74869eed5b8f9a1ea4',
    },
    {
      name: 'cudart-llama-b11960-bin-ubuntu-cuda-12.8-x64.tar.gz',
      sha256: '7c4d5974bd39649df649649e5d71950688a70e37aaae00bf11afbb656ea2cc56',
    },
  ],
  'darwin-arm64': [
    {
      name: 'llama-b11960-bin-macos-arm64.tar.gz',
      sha256: '58e5a5e1d7c2bf66cedd9c29e0323f3e570660a70a1e2156d32eed08f4cc1e3c',
    },
  ],
  'darwin-x64': [
    {
      name: 'llama-b11960-bin-macos-x64.tar.gz',
      sha256: 'd1e6c9ddcaed9a3b1bb8f3d946bdb3481c7b919357a4029dcb747762397f1da5',
    },
  ],
};
