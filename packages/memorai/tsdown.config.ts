import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: './src/index.ts',
    'storage/index': './src/storage/index.ts',
    'embeddings/index': './src/embeddings/index.ts',
  },
  clean: true,
  dts: true,
  platform: 'neutral',
})
