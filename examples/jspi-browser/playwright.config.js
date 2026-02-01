import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    timeout: 60000,
    use: {
        headless: true,
        trace: 'on-first-retry',
    },
    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: {
                    args: [
                        '--enable-experimental-webassembly-jspi',
                        '--enable-features=WebAssemblyJavaScriptPromiseIntegration',
                    ],
                },
            },
        },
    ],
});
