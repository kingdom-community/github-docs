import {defineConfig} from 'vitest/config';

export default defineConfig({
    test: {
        // Node, not jsdom: this package is server-side code that reads a token,
        // and none of it touches a DOM.
        environment: 'node',
        include: ['test/**/*.test.ts']
    }
});
