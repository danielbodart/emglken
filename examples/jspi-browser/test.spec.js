// @ts-check
import { test, expect } from '@playwright/test';

test.describe('JSPI Colossal Cave Adventure', () => {
    test('loads and runs the game', async ({ page }) => {
        // Enable console logging for debugging
        page.on('console', msg => {
            if (msg.type() === 'error') {
                console.log('Browser error:', msg.text());
            }
        });

        // Navigate to the page
        await page.goto('http://localhost:8080/');

        // Check page loaded
        await expect(page.locator('h1')).toContainText('Colossal Cave Adventure');

        // Wait for status to show JSPI check result
        const status = page.locator('#status');

        // Wait for either success or error (JSPI might not be supported in headless)
        await expect(status).not.toContainText('Checking JSPI support...', { timeout: 10000 });

        const statusText = await status.textContent();
        console.log('Status:', statusText);

        // If JSPI is not supported, that's expected in some browsers - test passes
        if (statusText?.includes('not supported')) {
            console.log('JSPI not supported in this browser - this is expected for some configurations');
            return;
        }

        // If we get here, JSPI is supported - wait for game to initialize
        // (might be instant or show "Loading" briefly)
        await expect(status).toContainText('initialized', { timeout: 30000 });

        // Check that output has some game text
        const output = page.locator('#output');
        await expect(output).not.toBeEmpty({ timeout: 10000 });

        const outputText = await output.textContent();
        console.log('Game output preview:', outputText?.substring(0, 200));

        // Verify the input is enabled (game is ready for input)
        const input = page.locator('#input');
        await expect(input).toBeEnabled({ timeout: 5000 });

        // Try entering a command
        await input.fill('look');
        await page.locator('#send').click();

        // Wait for response
        await page.waitForTimeout(2000);

        // Check output updated - the move counter should have incremented
        const newOutput = await output.textContent();
        console.log('After "look" command:', newOutput?.substring(0, 300));

        // Verify the game responded - move count should have changed from 1 to 2
        expect(newOutput).toContain('Moves: 2');
    });

    test('WASM files load correctly', async ({ page }) => {
        // Test that the WASM and story files are served correctly
        const wasmResponse = await page.request.get('http://localhost:8080/glulxe.wasm');
        expect(wasmResponse.status()).toBe(200);
        expect((await wasmResponse.body()).length).toBeGreaterThan(100000);

        const storyResponse = await page.request.get('http://localhost:8080/advent.ulx');
        expect(storyResponse.status()).toBe(200);
        expect((await storyResponse.body()).length).toBeGreaterThan(100000);
    });
});
