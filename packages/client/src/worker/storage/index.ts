/**
 * Storage Module
 *
 * Pluggable file storage for the WASI interpreter.
 */

// Types and constants
export { READ_ONLY_FILES } from './types';
export type {
  FilesystemMode,
  FileType,
  FileMode,
  FilePromptMetadata,
  FilePromptResult,
  StorageConfig,
  StorageProvider,
  DialogCapableProvider,
  DialogRequester,
} from './types';

// Factory
export { createStorageProvider, isDialogProvider } from './factory';
export type { CreateStorageOptions } from './factory';

// Providers (for direct use if needed)
export { MemoryProvider } from './memory-provider';
export { OpfsProvider } from './opfs-provider';
export { DialogProvider } from './dialog-provider';

// Utilities
export { generateFilename, getExtension } from './filename-generator';
