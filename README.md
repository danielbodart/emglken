# wasiglk

**Work in Progress** - Interactive Fiction interpreters compiled to WebAssembly (WASI) using Zig.

## Overview

wasiglk is inspired by [emglken](https://github.com/curiousdannii/emglken), which compiles IF interpreters to WebAssembly using Emscripten and Asyncify. This project takes a different approach:

| | emglken | wasiglk |
|---|---------|---------|
| **Compiler** | Emscripten | Zig (with C sources) |
| **Target** | JavaScript/WASM | WASI |
| **Async handling** | Asyncify (code transformation) | [JSPI](https://v8.dev/blog/jspi) (native browser feature) |
| **Glk implementation** | RemGlk-rs (Rust) | Custom Zig implementation |

**Why JSPI?** Asyncify transforms the entire WASM binary to support suspending execution, which increases code size and has performance overhead. JSPI is a native browser feature that allows WASM to suspend without transformation, resulting in smaller binaries and better performance.

The interpreters use a Glk implementation (in `packages/server/src/`) that communicates via JSON over stdin/stdout, compatible with the RemGlk protocol.

## Getting Started

The `./run` script auto-installs all required tools (Zig, Bun, wasi-sdk) on first run:

```bash
./run build    # Build all interpreters
./run test     # Run tests
./run serve    # Start dev server
```

## Interpreters

| Name | Language | Format | Extensions | License | WASM | Native |
|------|----------|--------|------------|---------|------|--------|
| [AdvSys](https://github.com/garglk/garglk) | C | AdvSys | .dat | [BSD-3-Clause](https://github.com/garglk/garglk/blob/master/licenses/BSD-3-Clause.txt) | ✅ | ✅ |
| [Agility](https://github.com/garglk/garglk) | C | AGT | .agx, .d$$ | [GPL-2.0](https://github.com/garglk/garglk/blob/master/licenses/GNU%20General%20Public%20License.txt) | ✅ | ✅ |
| [Alan2](https://github.com/garglk/garglk) | C | Alan 2 | .acd | [Artistic-2.0](https://github.com/garglk/garglk/blob/master/licenses/Artistic%20License%202.0.txt) | ✅ | ✅ |
| [Alan3](https://github.com/garglk/garglk) | C | Alan 3 | .a3c | [Artistic-2.0](https://github.com/garglk/garglk/blob/master/licenses/Artistic%20License%202.0.txt) | ✅ | ✅ |
| [Bocfel](https://github.com/garglk/garglk) | C++ | Z-machine | .z3-.z8 | [MIT](https://github.com/garglk/garglk/blob/master/licenses/MIT%20License.txt) | ❌ (C++ exceptions) | ✅ |
| [Git](https://github.com/DavidKinder/Git) | C | Glulx | .ulx, .gblorb | [MIT](https://github.com/DavidKinder/Git/blob/master/LICENSE) | ✅ | ✅ |
| [Glulxe](https://github.com/erkyrath/glulxe) | C | Glulx | .ulx, .gblorb | [MIT](https://github.com/erkyrath/glulxe/blob/master/LICENSE) | ✅ | ✅ |
| [Hugo](https://github.com/hugoif/hugo-unix) | C | Hugo | .hex | [BSD-2-Clause](https://github.com/hugoif/hugo-unix/blob/master/License.txt) | ✅ | ✅ |
| [JACL](https://github.com/garglk/garglk) | C | JACL | .j2 | [GPL-2.0](https://github.com/garglk/garglk/blob/master/licenses/GNU%20General%20Public%20License.txt) | ✅ | ✅ |
| [Level9](https://github.com/garglk/garglk) | C | Level 9 | .l9, .sna | [GPL-2.0](https://github.com/garglk/garglk/blob/master/licenses/GNU%20General%20Public%20License.txt) | ✅ | ✅ |
| [Magnetic](https://github.com/garglk/garglk) | C | Magnetic Scrolls | .mag | [GPL-2.0](https://github.com/garglk/garglk/blob/master/licenses/GNU%20General%20Public%20License.txt) | ✅ | ✅ |
| [Scare](https://github.com/garglk/garglk) | C | ADRIFT | .taf | [GPL-2.0](https://github.com/garglk/garglk/blob/master/licenses/GNU%20General%20Public%20License.txt) | ✅ | ✅ |
| [TADS](https://github.com/garglk/garglk) | C/C++ | TADS 2/3 | .gam, .t3 | [GPL-2.0](https://github.com/garglk/garglk/blob/master/licenses/GNU%20General%20Public%20License.txt) | ❌ (C++ exceptions) | ✅ |

### Native-Only Interpreters

**Bocfel and TADS** are C++ interpreters that use exceptions for control flow. WASM builds are blocked because wasi-sdk doesn't ship `libc++`/`libc++abi` with C++ exception support.

**What's needed for C++ WASM support:**
- wasi-sdk built with `LIBCXX_ENABLE_EXCEPTIONS=ON`, `LIBCXXABI_ENABLE_EXCEPTIONS=ON`, and `libunwind`
- Compile flags: `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false`
- Link flags: `-lunwind`

**Tracking:**
- [wasi-sdk#565](https://github.com/WebAssembly/wasi-sdk/issues/565) - C++ exception support tracking issue
- [Build instructions gist](https://gist.github.com/yerzham/302efcec6a2e82c1e8de4aed576ea29d) - How to build wasi-sdk with exception support (requires LLVM 21.1.5+)

## Browser Usage

The `@wasiglk/client` package provides a TypeScript client for running interpreters in the browser using JSPI.

**Browser Support:**
- Chrome 131+: JSPI enabled by default
- Chrome 128-130: Enable `chrome://flags/#enable-experimental-webassembly-jspi`

```typescript
import { createClient } from '@wasiglk/client';

// Create client (auto-detects format and loads appropriate interpreter)
const client = await createClient({
  storyUrl: '/stories/adventure.gblorb',
  // Or provide data directly:
  // storyData: new Uint8Array(...)
});

// Run the interpreter and handle updates
for await (const update of client.updates({ width: 80, height: 24 })) {
  switch (update.type) {
    case 'content':
      // Display text content
      console.log(update.text);
      break;

    case 'input':
      // Prompt user for input
      const input = await getUserInput(update.inputType);
      client.sendInput(input);
      break;

    case 'window':
      // Handle window creation/updates
      break;
  }
}

// Stop the interpreter when done
client.stop();
```

The client handles:
- Automatic format detection from file extension or Blorb contents
- Loading the appropriate interpreter WASM module
- Parsing Blorb files and providing image URLs
- Converting RemGlk protocol to typed updates

See `examples/jspi-browser/` for a complete working example.

## Project Structure

```
wasiglk/
├── run                     # Build script (auto-installs tools)
├── package.json
├── packages/
│   ├── client/             # TypeScript client library
│   │   ├── src/            # Client source code
│   │   └── package.json
│   ├── server/             # Zig GLK implementation + interpreters
│   │   ├── build.zig       # Zig build configuration
│   │   └── src/
│   │       ├── root.zig    # Module entry point
│   │       ├── types.zig   # Core types and constants
│   │       ├── state.zig   # Internal data structures
│   │       ├── protocol.zig # RemGlk JSON protocol
│   │       ├── window.zig  # Window functions
│   │       ├── stream.zig  # Stream I/O functions
│   │       ├── event.zig   # Event handling
│   │       ├── ...         # Other Glk modules
│   │       ├── glk.h       # Glk API header
│   │       ├── gi_dispa.c  # Glk dispatch layer
│   │       └── gi_blorb.c  # Blorb support
│   ├── garglk/             # Garglk interpreters (submodule)
│   ├── git/                # Git interpreter (submodule)
│   ├── glulxe/             # Glulxe interpreter (submodule)
│   ├── hugo/               # Hugo interpreter (submodule)
│   └── zlib/               # zlib for Scare (submodule)
└── examples/
    └── jspi-browser/       # Browser JSPI example
```

## License

MIT. See [LICENSE](LICENSE) for details.

Individual interpreters retain their original licenses (MIT, BSD-2-Clause, or GPL-2.0).
