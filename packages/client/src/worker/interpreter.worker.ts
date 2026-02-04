/**
 * Interpreter Worker
 *
 * Runs the WASM interpreter in a Web Worker using browser_wasi_shim.
 * Uses JSPI for async stdin and pluggable file storage.
 */

import {
  WASI,
  File,
  Directory,
  PreopenDirectory,
  ConsoleStdout,
  WASIProcExit,
  wasi,
  type Inode,
} from '@bjorn3/browser_wasi_shim';
import { AsyncStdinFd } from './stdin';
import {
  createStorageProvider,
  isDialogProvider,
  type StorageProvider,
  type FileType,
  type FileMode,
} from './storage';
import type { MainToWorkerMessage, WorkerToMainMessage } from './messages';
import type { InputEvent, RemGlkUpdate } from '../protocol';

let inputResolve: ((value: string) => void) | null = null;
let generation = 0;
let currentInputRequest: { windowId: number; type: 'line' | 'char' } | null = null;
let timerIntervalId: ReturnType<typeof setInterval> | null = null;

// File dialog state (for dialog mode)
let pendingFileDialog: { filemode: FileMode; filetype: FileType } | null = null;
let fileDialogResolve: ((result: { filename: string | null; handle?: FileSystemFileHandle }) => void) | null = null;

// Storage provider (set during init)
let storageProvider: StorageProvider | null = null;

/**
 * Build metrics object for RemGLK protocol from WorkerMetrics.
 * Includes all GlkOte spec fields with sensible defaults.
 */
function buildMetrics(m: import('./messages').WorkerMetrics): import('../protocol').Metrics {
  return {
    width: m.width,
    height: m.height,
    charwidth: m.charWidth,
    charheight: m.charHeight,
    // Spacing defaults
    outspacingx: m.outSpacingX ?? 0,
    outspacingy: m.outSpacingY ?? 0,
    inspacingx: m.inSpacingX ?? 0,
    inspacingy: m.inSpacingY ?? 0,
    // Grid window metrics (use generic char dimensions as fallback)
    gridcharwidth: m.gridCharWidth ?? m.charWidth,
    gridcharheight: m.gridCharHeight ?? m.charHeight,
    gridmarginx: m.gridMarginX ?? 0,
    gridmarginy: m.gridMarginY ?? 0,
    // Buffer window metrics (use generic char dimensions as fallback)
    buffercharwidth: m.bufferCharWidth ?? m.charWidth,
    buffercharheight: m.bufferCharHeight ?? m.charHeight,
    buffermarginx: m.bufferMarginX ?? 0,
    buffermarginy: m.bufferMarginY ?? 0,
    // Graphics window margins
    graphicsmarginx: m.graphicsMarginX ?? 0,
    graphicsmarginy: m.graphicsMarginY ?? 0,
  };
}

function post(msg: WorkerToMainMessage): void {
  self.postMessage(msg);
}

self.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    await runInterpreter(msg);
  } else if (msg.type === 'input' && inputResolve) {
    const resolve = inputResolve;
    inputResolve = null;
    // Format as RemGlk input event
    const inputEvent = {
      type: currentInputRequest?.type ?? 'line',
      gen: generation,
      window: currentInputRequest?.windowId ?? 0,
      value: msg.value,
    };
    resolve(JSON.stringify(inputEvent));
  } else if (msg.type === 'arrange' && inputResolve) {
    // Send arrange event to interrupt current input request
    const resolve = inputResolve;
    inputResolve = null;
    resolve(JSON.stringify({
      type: 'arrange',
      gen: generation,
      metrics: buildMetrics(msg.metrics),
    }));
  } else if (msg.type === 'mouse' && inputResolve) {
    // Send mouse click event to interrupt current input request
    const resolve = inputResolve;
    inputResolve = null;
    resolve(JSON.stringify({
      type: 'mouse',
      gen: generation,
      window: msg.windowId,
      x: msg.x,
      y: msg.y,
    }));
  } else if (msg.type === 'hyperlink' && inputResolve) {
    // Send hyperlink click event to interrupt current input request
    const resolve = inputResolve;
    inputResolve = null;
    resolve(JSON.stringify({
      type: 'hyperlink',
      gen: generation,
      window: msg.windowId,
      value: msg.linkValue,
    }));
  } else if (msg.type === 'redraw' && inputResolve) {
    // Send redraw request to interrupt current input request
    const resolve = inputResolve;
    inputResolve = null;
    resolve(JSON.stringify({
      type: 'redraw',
      gen: generation,
      window: msg.windowId,
    }));
  } else if (msg.type === 'refresh' && inputResolve) {
    // Send refresh request to get full state resent
    const resolve = inputResolve;
    inputResolve = null;
    resolve(JSON.stringify({
      type: 'refresh',
      gen: generation,
    }));
  } else if (msg.type === 'fileDialogResult' && fileDialogResolve) {
    // File dialog completed, resolve the pending promise
    const resolve = fileDialogResolve;
    fileDialogResolve = null;
    resolve({ filename: msg.filename, handle: msg.handle });
  } else if (msg.type === 'stop') {
    self.close();
  }
};

async function runInterpreter(msg: MainToWorkerMessage & { type: 'init' }): Promise<void> {
  try {
    // Initialize storage provider based on filesystem mode
    storageProvider = await createStorageProvider({
      mode: msg.filesystem,
      storyId: msg.storyId,
    });

    // Set up dialog requester for dialog-capable providers
    if (isDialogProvider(storageProvider)) {
      storageProvider.setDialogRequester(async (filemode, filetype) => {
        // Request file dialog from main thread
        post({
          type: 'fileDialogRequest',
          filemode,
          filetype,
        });
        // Wait for result
        return new Promise(resolve => {
          fileDialogResolve = resolve;
        });
      });
    }

    // Initialize storage and get existing files
    const rootContents = await storageProvider.initialize();

    // stdin: async for JSPI
    const stdin = new AsyncStdinFd(async () => {
      if (generation === 0) {
        generation = 1;
        return JSON.stringify({
          type: 'init',
          gen: 0,
          metrics: buildMetrics(msg.metrics),
          // Declare features the display supports (per GlkOte spec)
          support: ['timer', 'graphics', 'graphicswin', 'hyperlinks'],
        } satisfies InputEvent);
      }

      // Check for pending file dialog
      if (pendingFileDialog) {
        const dialogInfo = pendingFileDialog;
        pendingFileDialog = null;

        // Let the storage provider handle the prompt
        const result = await storageProvider!.handlePrompt({
          filetype: dialogInfo.filetype,
          filemode: dialogInfo.filemode,
        });

        return JSON.stringify({
          type: 'specialresponse',
          gen: generation,
          response: 'fileref_prompt',
          value: result.filename,
        });
      }

      return new Promise<string>(resolve => { inputResolve = resolve; });
    });

    // stdout: parse JSON updates
    const stdout = ConsoleStdout.lineBuffered((line: string) => {
      if (!line.trim()) return;
      try {
        const update = JSON.parse(line) as RemGlkUpdate;
        // Track generation for input responses
        if (update.gen !== undefined) {
          generation = update.gen;
        }
        // Track current input request
        if (update.input && update.input.length > 0) {
          currentInputRequest = {
            windowId: update.input[0].id,
            type: update.input[0].type,
          };
        }
        // Handle timer updates
        if (update.timer !== undefined) {
          handleTimerUpdate(update.timer);
        }
        // Handle special input (file dialogs)
        // Just set the pending dialog - the stdin handler will process it
        // and the storage provider will handle requesting dialogs if needed
        if (update.specialinput) {
          pendingFileDialog = {
            filemode: update.specialinput.filemode as FileMode,
            filetype: update.specialinput.filetype as FileType,
          };
        }
        post({ type: 'update', data: update });
      } catch {
        console.log('[interpreter]', line);
      }
    });

    // stderr - use console.debug for debug messages from the interpreter
    const stderr = ConsoleStdout.lineBuffered(line => console.debug('[interpreter]', line));

    // Filesystem: Unix-like structure
    // /sys/  - read-only system files (story)
    // /var/  - auto-managed data (saves, transcripts) - from storage provider
    // /home/ - user files from dialogs
    const sysDir = new Directory(new Map([
      ['story.ulx', new File(msg.story, { readonly: true })],
    ]));
    const homeContents = new Map<string, Inode>();
    const homeDir = new Directory(homeContents);

    // Give dialog provider access to /home/ directory
    if (isDialogProvider(storageProvider)) {
      storageProvider.setHomeDirectory(homeContents);
    }

    // Root combines system dirs with storage provider contents (which go in /var/)
    const rootMap = new Map<string, Inode>([
      ['sys', sysDir],
      ['var', new Directory(rootContents)],  // Storage provider files go here
      ['home', homeDir],
    ]);

    const root = new PreopenDirectory('/', rootMap);

    // Create WASI and instantiate
    const wasiInstance = new WASI(msg.args, [], [stdin, stdout, stderr, root]);
    const module = await WebAssembly.compile(msg.interpreter);
    const imports = wrapWithJSPI(wasiInstance, stdin, storageProvider, root);
    const instance = await WebAssembly.instantiate(module, imports);
    wasiInstance.inst = instance as { exports: { memory: WebAssembly.Memory } };

    // Run with JSPI
    const main = (instance.exports._start ?? instance.exports.main) as Function | undefined;
    if (!main) throw new Error('No _start or main export found');

    // @ts-expect-error - JSPI API
    const promisedMain = WebAssembly.promising(main);

    try {
      await promisedMain();
      post({ type: 'exit', code: 0 });
    } catch (err) {
      if (err instanceof WASIProcExit) {
        post({ type: 'exit', code: err.code });
      } else {
        throw err;
      }
    } finally {
      // Clean up storage handles to release file locks
      storageProvider?.close();
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
}

function wrapWithJSPI(
  wasiInstance: WASI,
  stdin: AsyncStdinFd,
  provider: StorageProvider,
  root: PreopenDirectory,
): WebAssembly.Imports {
  const imports = wasiInstance.wasiImport;
  const ROOT_FD = 3; // Root preopen directory is fd 3

  // Async fd_read for stdin (other fds use sync path)
  const asyncFdRead = async (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): Promise<number> => {
    // Stdin - async via JSPI
    if (fd === 0) {
      const memory = wasiInstance.inst.exports.memory;
      const view = new DataView(memory.buffer);
      const bytes = new Uint8Array(memory.buffer);

      let nread = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = view.getUint32(iovsPtr + i * 8, true);
        const len = view.getUint32(iovsPtr + i * 8 + 4, true);
        const { ret, data } = await stdin.fd_read_async(len);
        if (ret !== wasi.ERRNO_SUCCESS) {
          view.setUint32(nreadPtr, nread, true);
          return ret;
        }
        bytes.set(data, buf);
        nread += data.length;
        if (data.length < len) break;
      }
      view.setUint32(nreadPtr, nread, true);
      return wasi.ERRNO_SUCCESS;
    }

    // Other fds - sync (AsyncFSAFile.read() is sync via inherited WasiFile)
    return imports.fd_read(fd, iovsPtr, iovsLen, nreadPtr) as number;
  };


  // Async path_open for persistent file creation
  const asyncPathOpen = async (
    fd: number,
    dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    fsRightsBase: bigint,
    fsRightsInheriting: bigint,
    fdFlags: number,
    openedFdPtr: number,
  ): Promise<number> => {
    const memory = wasiInstance.inst.exports.memory;
    const bytes = new Uint8Array(memory.buffer);

    // Decode path string
    const path = new TextDecoder().decode(bytes.slice(pathPtr, pathPtr + pathLen));
    console.log(`[wasi] path_open: fd=${fd} path="${path}" oflags=${oflags}`);

    // Check if creating a file that should be persisted
    const shouldPersist =
      fd === ROOT_FD &&
      (oflags & wasi.OFLAGS_CREAT) !== 0 &&
      provider.shouldPersist(path);

    if (shouldPersist) {
      // Check if file already exists in the directory tree
      const existingFile = findFileInTree(root.dir, path);

      if (!existingFile) {
        try {
          // Async file creation - WASM suspends here
          await provider.createFile(path);
        } catch (err) {
          console.error(`[storage] Failed to create file ${path}:`, err);
          // Fall through to normal path_open which will create in-memory file
        }
      }
    }

    // Use normal path_open (now the file exists if we created it)
    return imports.path_open(
      fd, dirflags, pathPtr, pathLen, oflags,
      fsRightsBase, fsRightsInheriting, fdFlags, openedFdPtr,
    ) as number;
  };

  return {
    wasi_snapshot_preview1: {
      ...imports,
      // @ts-expect-error - JSPI API
      fd_read: new WebAssembly.Suspending(asyncFdRead),
      // @ts-expect-error - JSPI API
      path_open: new WebAssembly.Suspending(asyncPathOpen),
    },
  };
}

/**
 * Find a file in the directory tree by path.
 */
function findFileInTree(dir: Directory, path: string): Inode | null {
  const parts = path.split('/').filter(p => p.length > 0);
  let current: Inode = dir;

  for (const part of parts) {
    if (!(current instanceof Directory)) {
      return null;
    }
    const next = current.contents.get(part);
    if (!next) {
      return null;
    }
    current = next;
  }

  return current;
}

/**
 * Handle timer updates from the interpreter.
 * Sets up or cancels a JavaScript interval timer.
 */
function handleTimerUpdate(interval: number | null): void {
  // Clear any existing timer
  if (timerIntervalId !== null) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }

  // Set up new timer if interval is specified
  if (interval !== null && interval > 0) {
    timerIntervalId = setInterval(() => {
      // Fire timer event if we're waiting for input
      if (inputResolve) {
        const resolve = inputResolve;
        inputResolve = null;
        resolve(JSON.stringify({
          type: 'timer',
          gen: generation,
        }));
      }
    }, interval);
  }
}
