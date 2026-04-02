import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'index.ts'),
            formats: ['es'],
            fileName: () => 'index.mjs',
        },
        rollupOptions: {
            external: ['fs', 'path', 'napcat-types/napcat-onebot/network/plugin-manger', 'url'],
        },
        outDir: 'dist',
        emptyOutDir: false,
    },
});
