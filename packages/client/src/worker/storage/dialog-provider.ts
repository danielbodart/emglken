/**
 * Dialog Storage Provider
 *
 * Hybrid provider that uses OPFS for base storage (create_by_name)
 * and File System Access API dialogs for user-prompted files (create_by_prompt).
 *
 * Uses AsyncFSAFile for dialog files - sync operations on memory buffer
 * with eventual consistency to external file.
 */

import type { Inode } from '@bjorn3/browser_wasi_shim';
import type {
  DialogCapableProvider,
  StorageConfig,
  FilePromptMetadata,
  FilePromptResult,
  DialogRequester,
} from './types';
import { OpfsProvider } from './opfs-provider';
import {
  AsyncFSAFile,
  createAsyncFSAFileForRead,
  createAsyncFSAFileForWrite,
} from './async-fsa-file';

/**
 * Dialog-based storage provider.
 *
 * - create_by_name: Delegates to OPFS provider (for auto-saves in /var/)
 * - create_by_prompt: Creates AsyncFSAFile wrapping the picker's file handle
 */
export class DialogProvider implements DialogCapableProvider {
  private readonly opfsProvider: OpfsProvider;
  private dialogRequester: DialogRequester | null = null;
  private rootContents: Map<string, Inode> = new Map();
  /** Contents for /home/ directory (user files from dialogs) */
  private homeContents: Map<string, Inode> | null = null;
  /** Track AsyncFSAFile instances for cleanup */
  private readonly asyncFiles: Map<string, AsyncFSAFile> = new Map();

  constructor(private readonly config: StorageConfig) {
    this.opfsProvider = new OpfsProvider(config);
  }

  /**
   * Check if File System Access API is available.
   * Note: This check is for main thread. Worker availability is handled differently.
   */
  static isAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      'showOpenFilePicker' in window &&
      'showSaveFilePicker' in window
    );
  }

  setDialogRequester(requester: DialogRequester): void {
    this.dialogRequester = requester;
  }

  /**
   * Set the /home/ directory contents map for user files from dialogs.
   */
  setHomeDirectory(homeContents: Map<string, Inode>): void {
    this.homeContents = homeContents;
  }

  async initialize(): Promise<Map<string, Inode>> {
    // Initialize OPFS as base storage (for /var/ files)
    this.rootContents = await this.opfsProvider.initialize();
    console.log('[dialog] Initialized with OPFS base storage');
    return this.rootContents;
  }

  async createFile(path: string): Promise<void> {
    // Delegate to OPFS for programmatic file creation
    await this.opfsProvider.createFile(path);
  }

  async handlePrompt(metadata: FilePromptMetadata): Promise<FilePromptResult> {
    if (!this.dialogRequester) {
      console.error('[dialog] No dialog requester set, falling back to auto-generate');
      return this.opfsProvider.handlePrompt(metadata);
    }

    try {
      // Request file dialog from main thread
      const result = await this.dialogRequester(metadata.filemode, metadata.filetype);

      if (result.filename === null || !result.handle) {
        console.log('[dialog] User cancelled file dialog');
        return { filename: null };
      }

      // Create AsyncFSAFile based on mode
      const isRead = metadata.filemode === 'read';
      const basename = await this.mountAsyncFSAFile(result.handle, result.filename, isRead);

      // Return full WASI path so interpreter can find it
      const filename = `/home/${basename}`;
      console.log(`[dialog] Mounted AsyncFSAFile for ${isRead ? 'read' : 'write'}: ${filename}`);
      return { filename };
    } catch (err) {
      console.error('[dialog] File dialog failed:', err);
      return { filename: null };
    }
  }

  /**
   * Mount a FileSystemFileHandle as an AsyncFSAFile in /home/.
   */
  private async mountAsyncFSAFile(
    handle: FileSystemFileHandle,
    filename: string,
    isRead: boolean
  ): Promise<string> {
    if (!this.homeContents) {
      throw new Error('/home/ directory not set - call setHomeDirectory first');
    }

    // Clean up existing file with same name if any
    this.asyncFiles.delete(filename);
    this.homeContents.delete(filename);

    // Create AsyncFSAFile - for read, data is loaded; for write, starts empty
    const asyncFile = isRead
      ? await createAsyncFSAFileForRead(handle)
      : createAsyncFSAFileForWrite(handle);

    this.asyncFiles.set(filename, asyncFile);
    this.homeContents.set(filename, asyncFile);

    return filename;
  }

  shouldPersist(path: string): boolean {
    return this.opfsProvider.shouldPersist(path);
  }

  async close(): Promise<void> {
    this.asyncFiles.clear();
    this.opfsProvider.close();
    console.log('[dialog] Closed');
  }
}
