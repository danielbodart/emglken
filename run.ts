#!/usr/bin/env ./bootstrap.sh
import {$, spawn, Glob} from "bun";

process.env.FORCE_COLOR = "1";

export async function clean() {
    await $`rm -rf packages/server/zig-out packages/server/zig-cache packages/server/.zig-cache`;
}

export async function build(...args: string[]) {
    await buildZig(...args);
    await optimize();
}

// Build Zig interpreters (server package)
export async function buildZig(...args: string[]) {
    // Default to ReleaseSmall for WASM size optimization
    const optimize = args.includes('-Doptimize=') ? [] : ['-Doptimize=ReleaseSmall'];
    await $`zig build --build-file packages/server/build.zig --prefix packages/server/zig-out ${optimize} ${args}`;
}

// Optimize WASM binaries with Binaryen wasm-opt
export async function optimize() {
    const glob = new Glob("packages/server/zig-out/bin/*.wasm");
    const wasmFiles = Array.from(glob.scanSync("."));

    if (wasmFiles.length === 0) {
        console.log("No WASM files to optimize");
        return;
    }

    console.log(`Optimizing ${wasmFiles.length} WASM files with wasm-opt...`);
    const wasmOpt = "./node_modules/.bin/wasm-opt";

    for (const file of wasmFiles) {
        const before = Bun.file(file).size;
        await $`${wasmOpt} -Oz \
            --enable-bulk-memory \
            --enable-exception-handling \
            --enable-nontrapping-float-to-int \
            --enable-sign-ext \
            --enable-mutable-globals \
            --enable-reference-types \
            --enable-typed-function-references \
            ${file} -o ${file}`.quiet();
        const after = Bun.file(file).size;
        const saved = before - after;
        const percent = Math.round(saved * 100 / before);
        console.log(`  ${file.split('/').pop()}: ${before} -> ${after} (${percent}% smaller)`);
    }
}

// Build TypeScript client library
export async function buildClient() {
    await $`bun run --cwd packages/client build`;
}

// Run client unit tests
export async function testClient() {
    await $`bun test --cwd packages/client`;
}

// Run all tests (client unit tests + E2E)
export async function test(...args: string[]) {
    // Run client unit tests first
    await testClient();

    // Then run E2E tests
    await testE2E(...args);
}

// Run E2E browser tests
export async function testE2E(...args: string[]) {
    // Start the dev server in background
    const server = spawn({
        cmd: ['bun', 'run', 'packages/example/serve.ts'],
        stdout: 'inherit',
        stderr: 'inherit',
    });

    // Wait for server to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));

    try {
        // Playwright's test runner requires Node - bunx has compatibility issues
        await $`npx playwright test --config=packages/example/playwright.config.js ${args}`;
    } finally {
        server.kill();
    }
}

// Run tests with browser visible (useful for debugging)
export async function testHeaded(...args: string[]) {
    await test('--headed', ...args);
}

// Run the example/demo
export async function demo() {
    await $`bun run packages/example/serve.ts`;
}

// Alias for demo
export async function serve() {
    await demo();
}

export async function ci() {
    await clean();
    await build();
    await test();
}

const command = process.argv[2] || 'build';
const args = process.argv.slice(3);

try {
    await eval(command)(...args);
} catch (e: any) {
    if (e instanceof ReferenceError) {
        const { exitCode } = await $`${command} ${args}`.nothrow();
        process.exit(exitCode);
    } else {
        console.error('Command failed:', command, ...args, e.message);
        process.exit(1);
    }
}
