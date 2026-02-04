/**
 * AsyncFSAFile - A file inode backed by the File System Access API.
 *
 * In-memory buffer is the source of truth. External file is written
 * once on fd_close() as fire-and-forget.
 */

import { File as WasiFile, OpenFile, wasi } from '@bjorn3/browser_wasi_shim';

/**
 * Create an AsyncFSAFile for reading.
 * Reads the external file contents immediately into the buffer.
 * Handle is not retained - we have the data.
 */
export async function createAsyncFSAFileForRead(
  handle: FileSystemFileHandle
): Promise<AsyncFSAFile> {
  const file = await handle.getFile();
  const data = new Uint8Array(await file.arrayBuffer());
  console.log(`[async-fsa] Read ${data.length} bytes from external file`);
  return new AsyncFSAFile(data, null);
}

/**
 * Create an AsyncFSAFile for writing.
 * Starts with empty buffer, retains handle for write on close.
 */
export function createAsyncFSAFileForWrite(
  handle: FileSystemFileHandle
): AsyncFSAFile {
  console.log(`[async-fsa] Created for write`);
  return new AsyncFSAFile(new Uint8Array(0), handle);
}

/**
 * Custom OpenFile that writes to external handle on close.
 */
class AsyncOpenFile extends OpenFile {
  constructor(
    private asyncFile: AsyncFSAFile,
    private externalHandle: FileSystemFileHandle | null
  ) {
    super(asyncFile);
  }

  /**
   * Close: write final buffer to external file.
   */
  fd_close(): number {
    this.writeToExternal();
    return 0;
  }

  /**
   * Fire-and-forget write current buffer to external file.
   */
  private writeToExternal(): void {
    if (!this.externalHandle) return;

    const handle = this.externalHandle;
    const data = this.asyncFile.data;

    // Fire and forget - don't await
    (async () => {
      try {
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        console.log(`[async-fsa] Wrote ${data.length} bytes to external file`);
      } catch (err) {
        console.error('[async-fsa] Failed to write to external file:', err);
      }
    })();
  }
}

/**
 * File inode that writes to external File System Access handle on close.
 */
export class AsyncFSAFile extends WasiFile {
  private externalHandle: FileSystemFileHandle | null;

  constructor(data: Uint8Array, handle: FileSystemFileHandle | null) {
    super(data);
    this.externalHandle = handle;
  }

  /**
   * Override path_open to return our custom AsyncOpenFile.
   */
  path_open(
    oflags: number,
    fs_rights_base: bigint,
    fd_flags: number
  ): { ret: number; fd_obj: AsyncOpenFile | null } {
    // Check write permission on readonly files
    if (this.readonly && (fs_rights_base & BigInt(wasi.RIGHTS_FD_WRITE)) === BigInt(wasi.RIGHTS_FD_WRITE)) {
      return { ret: wasi.ERRNO_PERM, fd_obj: null };
    }

    // Handle truncate
    if ((oflags & wasi.OFLAGS_TRUNC) === wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { ret: wasi.ERRNO_PERM, fd_obj: null };
      this.data = new Uint8Array([]);
    }

    const file = new AsyncOpenFile(this, this.externalHandle);

    // Handle append mode
    if (fd_flags & wasi.FDFLAGS_APPEND) {
      file.fd_seek(0n, wasi.WHENCE_END);
    }

    return { ret: wasi.ERRNO_SUCCESS, fd_obj: file };
  }
}
