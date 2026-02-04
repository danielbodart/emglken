/**
 * Dialog Storage Provider
 *
 * Hybrid provider that uses OPFS for base storage (create_by_name)
 * and File System Access API dialogs for user-prompted files (create_by_prompt).
 */

import { SyncOPFSFile, type Inode } from '@bjorn3/browser_wasi_shim';
import type {
  DialogCapableProvider,
  StorageConfig,
  FilePromptMetadata,
  FilePromptResult,
  DialogRequester,
} from './types';
import { OpfsProvider } from './opfs-provider';
import { getExtension } from './filename-generator';

/**
 * Dialog-based storage provider.
 *
 * - create_by_name: Delegates to OPFS provider
 * - create_by_prompt: Shows file picker via main thread
 */
export class DialogProvider implements DialogCapableProvider {
  private readonly opfsProvider: OpfsProvider;
  private dialogRequester: DialogRequester | null = null;
  private rootContents: Map<string, Inode> = new Map();
  private externalFileCounter = 0;
  /** Track external file handles for cleanup */
  private readonly externalHandles: FileSystemSyncAccessHandle[] = [];

  constructor(config: StorageConfig) {
    this.opfsProvider = new OpfsProvider(config);
  }

  /**
   * Check if File System Access API is available.
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

  async initialize(): Promise<Map<string, Inode>> {
    // Initialize OPFS as base storage
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

      // Mount the file handle
      const filename = await this.mountExternalFile(result.handle, metadata.filetype);
      console.log(`[dialog] Mounted external file: ${filename}`);
      return { filename };
    } catch (err) {
      console.error('[dialog] File dialog failed:', err);
      return { filename: null };
    }
  }

  /**
   * Mount an external file handle into the WASI filesystem.
   */
  private async mountExternalFile(
    handle: FileSystemFileHandle,
    filetype: string
  ): Promise<string> {
    const ext = getExtension(filetype);
    const filename = `__external_${this.externalFileCounter}.${ext}`;

    try {
      const syncHandle = await handle.createSyncAccessHandle();
      this.externalHandles.push(syncHandle);
      const externalFile = new SyncOPFSFile(syncHandle);
      this.rootContents.set(filename, externalFile);
      this.externalFileCounter++; // Increment only after success
      return filename;
    } catch (err) {
      console.error('[dialog] Failed to create sync access handle:', err);
      throw err;
    }
  }

  shouldPersist(path: string): boolean {
    // External files are handled separately, delegate rest to OPFS
    if (path.startsWith('__external_')) {
      return false; // Already mounted directly
    }
    return this.opfsProvider.shouldPersist(path);
  }

  close(): void {
    // Close external file handles
    for (const handle of this.externalHandles) {
      try {
        handle.close();
      } catch (err) {
        console.warn('[dialog] Failed to close external handle:', err);
      }
    }
    this.externalHandles.length = 0;

    this.opfsProvider.close();
    console.log('[dialog] Closed');
  }
}
