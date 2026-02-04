/**
 * Storage Provider Types
 *
 * Defines interfaces for pluggable file storage backends.
 */

import type { Inode } from '@bjorn3/browser_wasi_shim';

/** Files that should not be persisted (read-only game files) */
export const READ_ONLY_FILES = new Set(['story.ulx']);

/** File system configuration mode */
export type FilesystemMode = 'auto' | 'opfs' | 'memory' | 'dialog';

/** GlkOte file types */
export type FileType = 'save' | 'data' | 'transcript' | 'command';

/** GlkOte file modes */
export type FileMode = 'read' | 'write' | 'readwrite' | 'writeappend';

/** Metadata for file creation via prompt */
export interface FilePromptMetadata {
  filetype: FileType;
  filemode: FileMode;
}

/** Result from createByPrompt */
export interface FilePromptResult {
  /** The filename to use, or null if cancelled */
  filename: string | null;
}

/** Configuration for storage providers */
export interface StorageConfig {
  storyId: string;
}

/**
 * Storage provider interface.
 *
 * Implementations handle file persistence for different backends:
 * - MemoryProvider: In-memory only (no persistence)
 * - OpfsProvider: Origin Private File System (persistent)
 * - DialogProvider: File System Access API dialogs + OPFS base
 */
export interface StorageProvider {
  /**
   * Initialize the storage and load existing files.
   * @returns Map of filenames to Inode objects for the WASI filesystem
   */
  initialize(): Promise<Map<string, Inode>>;

  /**
   * Create a file by explicit path (programmatic, no user interaction).
   * Used by create_by_name and autosave.
   * @param path - File path relative to root
   * @returns Promise that resolves when file is ready
   */
  createFile(path: string): Promise<void>;

  /**
   * Handle file creation by user prompt.
   * Used by create_by_prompt (save/restore dialogs).
   * @param metadata - File type and mode information
   * @returns Filename to use, or null if cancelled
   */
  handlePrompt(metadata: FilePromptMetadata): Promise<FilePromptResult>;

  /**
   * Check if a path should be persisted.
   * @param path - File path to check
   * @returns true if the file should be persisted
   */
  shouldPersist(path: string): boolean;

  /**
   * Clean up resources (close file handles, etc.)
   */
  close(): void;
}

/**
 * Extended provider interface for dialog-capable providers.
 * Dialog providers need to communicate with the main thread.
 */
export interface DialogCapableProvider extends StorageProvider {
  /**
   * Set the function to request file dialogs from the main thread.
   */
  setDialogRequester(requester: DialogRequester): void;
}

/** Function type for requesting file dialogs from main thread */
export type DialogRequester = (
  filemode: FileMode,
  filetype: FileType
) => Promise<{ filename: string | null; handle?: FileSystemFileHandle }>;
