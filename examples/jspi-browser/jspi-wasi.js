/**
 * JSPI-enabled WASI implementation for running IF interpreters in the browser
 *
 * This uses WebAssembly JavaScript Promise Integration (JSPI) to allow
 * the synchronous WASI code to suspend while waiting for user input.
 */

/**
 * Create a JSPI-enabled WASI instance
 * @param {Object} options
 * @param {string[]} options.args - Command line arguments
 * @param {Object} options.env - Environment variables
 * @param {Uint8Array} options.storyData - The story file data
 * @param {Function} options.onOutput - Called with output JSON from interpreter
 * @param {Function} options.getInput - Async function that returns user input
 */
export function createJSPIWasi(options) {
    const {
        args = ['glulxe', '/story.ulx'],
        env = {},
        storyData,
        onOutput,
        getInput,
    } = options;

    // WASM memory reference (set during instantiation)
    let memory = null;

    // File descriptors
    // 0 = stdin, 1 = stdout, 2 = stderr
    // 3+ = opened files
    const openFiles = new Map();
    let nextFd = 3;

    // Buffers for stdin/stdout
    let stdinBuffer = '';
    let stdinPos = 0;
    let stdoutBuffer = '';

    // Track if we've sent the init message
    let initSent = false;

    // Helper to read a string from WASM memory
    function readString(ptr, len) {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        return new TextDecoder().decode(bytes);
    }

    // Helper to write a string to WASM memory
    function writeString(ptr, str, maxLen) {
        const bytes = new TextEncoder().encode(str);
        const len = Math.min(bytes.length, maxLen);
        const target = new Uint8Array(memory.buffer, ptr, len);
        target.set(bytes.subarray(0, len));
        return len;
    }

    // Helper to read iovec structures
    function readIovecs(iovsPtr, iovsLen) {
        const iovecs = [];
        const view = new DataView(memory.buffer);
        for (let i = 0; i < iovsLen; i++) {
            const base = iovsPtr + i * 8;
            const ptr = view.getUint32(base, true);
            const len = view.getUint32(base + 4, true);
            iovecs.push({ ptr, len });
        }
        return iovecs;
    }

    // Process stdout - collect JSON lines and call onOutput
    function processStdout() {
        const lines = stdoutBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
            if (line.trim()) {
                try {
                    const json = JSON.parse(line);
                    onOutput(json);
                } catch (e) {
                    console.warn('Non-JSON output:', line);
                }
            }
        }
    }

    // The WASI imports
    const wasiImports = {
        // Args
        args_sizes_get(argcPtr, argvBufSizePtr) {
            const view = new DataView(memory.buffer);
            view.setUint32(argcPtr, args.length, true);
            let bufSize = 0;
            for (const arg of args) {
                bufSize += new TextEncoder().encode(arg).length + 1;
            }
            view.setUint32(argvBufSizePtr, bufSize, true);
            return 0;
        },

        args_get(argvPtr, argvBufPtr) {
            const view = new DataView(memory.buffer);
            let bufOffset = 0;
            for (let i = 0; i < args.length; i++) {
                view.setUint32(argvPtr + i * 4, argvBufPtr + bufOffset, true);
                const bytes = new TextEncoder().encode(args[i] + '\0');
                new Uint8Array(memory.buffer, argvBufPtr + bufOffset, bytes.length).set(bytes);
                bufOffset += bytes.length;
            }
            return 0;
        },

        // Environment
        environ_sizes_get(countPtr, sizePtr) {
            const view = new DataView(memory.buffer);
            const entries = Object.entries(env);
            view.setUint32(countPtr, entries.length, true);
            let size = 0;
            for (const [k, v] of entries) {
                size += new TextEncoder().encode(`${k}=${v}`).length + 1;
            }
            view.setUint32(sizePtr, size, true);
            return 0;
        },

        environ_get(environPtr, environBufPtr) {
            const view = new DataView(memory.buffer);
            const entries = Object.entries(env);
            let bufOffset = 0;
            for (let i = 0; i < entries.length; i++) {
                view.setUint32(environPtr + i * 4, environBufPtr + bufOffset, true);
                const bytes = new TextEncoder().encode(`${entries[i][0]}=${entries[i][1]}\0`);
                new Uint8Array(memory.buffer, environBufPtr + bufOffset, bytes.length).set(bytes);
                bufOffset += bytes.length;
            }
            return 0;
        },

        // Clock
        clock_time_get(clockId, precision, timePtr) {
            const view = new DataView(memory.buffer);
            const now = BigInt(Date.now()) * 1000000n; // Convert to nanoseconds
            view.setBigUint64(timePtr, now, true);
            return 0;
        },

        clock_res_get(clockId, resPtr) {
            const view = new DataView(memory.buffer);
            view.setBigUint64(resPtr, 1000000n, true); // 1ms resolution
            return 0;
        },

        // File descriptors
        fd_close(fd) {
            if (fd >= 3) {
                openFiles.delete(fd);
            }
            return 0;
        },

        fd_fdstat_get(fd, statPtr) {
            const view = new DataView(memory.buffer);
            // fs_filetype (u8)
            if (fd <= 2) {
                view.setUint8(statPtr, 2); // character device
            } else {
                view.setUint8(statPtr, 4); // regular file
            }
            // fs_flags (u16)
            view.setUint16(statPtr + 2, 0, true);
            // fs_rights_base (u64)
            view.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);
            // fs_rights_inheriting (u64)
            view.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true);
            return 0;
        },

        fd_fdstat_set_flags(fd, flags) {
            return 0;
        },

        fd_prestat_get(fd, prestatPtr) {
            // We preopened fd 3 as "/"
            if (fd === 3) {
                const view = new DataView(memory.buffer);
                view.setUint8(prestatPtr, 0); // __WASI_PREOPENTYPE_DIR
                view.setUint32(prestatPtr + 4, 1, true); // name length for "/"
                return 0;
            }
            return 8; // EBADF
        },

        fd_prestat_dir_name(fd, pathPtr, pathLen) {
            if (fd === 3) {
                const path = new Uint8Array(memory.buffer, pathPtr, pathLen);
                path[0] = '/'.charCodeAt(0);
                return 0;
            }
            return 8; // EBADF
        },

        fd_seek(fd, offset, whence, newOffsetPtr) {
            const view = new DataView(memory.buffer);
            const file = openFiles.get(fd);
            if (!file) {
                view.setBigUint64(newOffsetPtr, 0n, true);
                return 8; // EBADF
            }

            let newPos;
            switch (whence) {
                case 0: // SEEK_SET
                    newPos = Number(offset);
                    break;
                case 1: // SEEK_CUR
                    newPos = file.pos + Number(offset);
                    break;
                case 2: // SEEK_END
                    newPos = file.data.length + Number(offset);
                    break;
                default:
                    return 28; // EINVAL
            }

            file.pos = Math.max(0, Math.min(newPos, file.data.length));
            view.setBigUint64(newOffsetPtr, BigInt(file.pos), true);
            return 0;
        },

        fd_tell(fd, offsetPtr) {
            const view = new DataView(memory.buffer);
            const file = openFiles.get(fd);
            if (!file) {
                return 8; // EBADF
            }
            view.setBigUint64(offsetPtr, BigInt(file.pos), true);
            return 0;
        },

        // Writing (non-suspending)
        fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
            const view = new DataView(memory.buffer);
            const iovecs = readIovecs(iovsPtr, iovsLen);

            let totalWritten = 0;
            for (const { ptr, len } of iovecs) {
                const data = readString(ptr, len);
                totalWritten += len;

                if (fd === 1) { // stdout
                    stdoutBuffer += data;
                } else if (fd === 2) { // stderr
                    console.error(data);
                } else {
                    const file = openFiles.get(fd);
                    if (file && file.writable) {
                        // For simplicity, we don't support writing to files yet
                    }
                }
            }

            // Process any complete lines in stdout
            if (fd === 1) {
                processStdout();
            }

            view.setUint32(nwrittenPtr, totalWritten, true);
            return 0;
        },

        // Reading - THIS IS THE SUSPENDING IMPORT
        // When reading from stdin (fd 0), we suspend and wait for user input
        fd_read: async (fd, iovsPtr, iovsLen, nreadPtr) => {
            const view = new DataView(memory.buffer);
            const iovecs = readIovecs(iovsPtr, iovsLen);

            let totalRead = 0;

            for (const { ptr, len } of iovecs) {
                if (totalRead > 0) break; // Only fill first buffer

                if (fd === 0) { // stdin
                    // If stdin buffer is empty, get more input
                    if (stdinPos >= stdinBuffer.length) {
                        // Flush any pending stdout first
                        processStdout();

                        // Send init if not yet sent
                        if (!initSent) {
                            initSent = true;
                            stdinBuffer = JSON.stringify({ type: 'init', gen: 0, metrics: { width: 80, height: 24 } }) + '\n';
                            stdinPos = 0;
                        } else {
                            // SUSPEND HERE - wait for user input
                            const input = await getInput();
                            stdinBuffer = JSON.stringify({ type: 'line', gen: 0, window: 1, value: input }) + '\n';
                            stdinPos = 0;
                        }
                    }

                    // Read from stdin buffer
                    const available = stdinBuffer.length - stdinPos;
                    const toRead = Math.min(len, available);
                    const bytes = new TextEncoder().encode(stdinBuffer.substring(stdinPos, stdinPos + toRead));
                    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
                    stdinPos += toRead;
                    totalRead += bytes.length;
                } else {
                    // Reading from a file
                    const file = openFiles.get(fd);
                    if (!file) {
                        view.setUint32(nreadPtr, 0, true);
                        return 8; // EBADF
                    }

                    const available = file.data.length - file.pos;
                    const toRead = Math.min(len, available);
                    const target = new Uint8Array(memory.buffer, ptr, toRead);
                    target.set(file.data.subarray(file.pos, file.pos + toRead));
                    file.pos += toRead;
                    totalRead += toRead;
                }
            }

            view.setUint32(nreadPtr, totalRead, true);
            return 0;
        },

        // Path operations
        path_open(dirFd, dirFlags, pathPtr, pathLen, oflags, fsRightsBase, fsRightsInheriting, fdflags, fdPtr) {
            const view = new DataView(memory.buffer);
            const path = readString(pathPtr, pathLen);

            // Check if this is our story file
            if (path === 'story.ulx' || path === '/story.ulx') {
                const fd = nextFd++;
                openFiles.set(fd, {
                    data: storyData,
                    pos: 0,
                    writable: false
                });
                view.setUint32(fdPtr, fd, true);
                return 0;
            }

            // File not found
            view.setUint32(fdPtr, 0, true);
            return 44; // ENOENT
        },

        path_filestat_get(fd, flags, pathPtr, pathLen, statPtr) {
            const path = readString(pathPtr, pathLen);
            const view = new DataView(memory.buffer);

            if (path === 'story.ulx' || path === '/story.ulx') {
                // dev
                view.setBigUint64(statPtr, 0n, true);
                // ino
                view.setBigUint64(statPtr + 8, 1n, true);
                // filetype (regular file = 4)
                view.setUint8(statPtr + 16, 4);
                // nlink
                view.setBigUint64(statPtr + 24, 1n, true);
                // size
                view.setBigUint64(statPtr + 32, BigInt(storyData.length), true);
                // atim, mtim, ctim
                view.setBigUint64(statPtr + 40, 0n, true);
                view.setBigUint64(statPtr + 48, 0n, true);
                view.setBigUint64(statPtr + 56, 0n, true);
                return 0;
            }

            return 44; // ENOENT
        },

        path_create_directory(fd, pathPtr, pathLen) {
            return 63; // ENOSYS
        },

        path_remove_directory(fd, pathPtr, pathLen) {
            return 63; // ENOSYS
        },

        path_unlink_file(fd, pathPtr, pathLen) {
            return 63; // ENOSYS
        },

        path_rename(oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) {
            return 63; // ENOSYS
        },

        // Random
        random_get(bufPtr, bufLen) {
            const buf = new Uint8Array(memory.buffer, bufPtr, bufLen);
            crypto.getRandomValues(buf);
            return 0;
        },

        // Process
        proc_exit(code) {
            throw new Error(`Process exited with code ${code}`);
        },

        sched_yield() {
            return 0;
        },

        // Poll (stub)
        poll_oneoff(inPtr, outPtr, nsubscriptions, neventsPtr) {
            const view = new DataView(memory.buffer);
            view.setUint32(neventsPtr, 0, true);
            return 0;
        },
    };

    return {
        /**
         * Get the imports object for WebAssembly instantiation
         * Must wrap fd_read with WebAssembly.Suspending for JSPI
         */
        getImports() {
            // Create a copy with fd_read wrapped as suspending
            const imports = { ...wasiImports };
            imports.fd_read = new WebAssembly.Suspending(wasiImports.fd_read);
            return { wasi_snapshot_preview1: imports };
        },

        /**
         * Set the WASM memory reference
         */
        setMemory(mem) {
            memory = mem;
        },

        /**
         * Initialize the filesystem with the story file
         */
        init() {
            // fd 3 is preopen for "/"
            openFiles.set(3, { isDir: true });
        }
    };
}

/**
 * Load and run a WASI module with JSPI support
 * @param {ArrayBuffer} wasmBytes - The WASM module bytes
 * @param {Object} options - Options for createJSPIWasi
 * @returns {Promise} - Resolves when the module exits
 */
export async function runWithJSPI(wasmBytes, options) {
    const wasi = createJSPIWasi(options);
    wasi.init();

    const imports = wasi.getImports();

    // Compile and instantiate
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await WebAssembly.instantiate(module, imports);

    // Set memory reference
    wasi.setMemory(instance.exports.memory);

    // Wrap the main function with WebAssembly.promising for JSPI
    const main = instance.exports._start || instance.exports.main;
    if (!main) {
        throw new Error('No _start or main export found');
    }

    const promisedMain = WebAssembly.promising(main);

    // Run!
    try {
        await promisedMain();
    } catch (e) {
        if (e.message && e.message.includes('Process exited')) {
            console.log('Interpreter exited normally');
        } else {
            throw e;
        }
    }
}
