/**
 * Storage Provider Factory
 *
 * Creates the appropriate storage provider based on configuration.
 */

import type { FilesystemMode, StorageProvider, StorageConfig } from './types';
import { MemoryProvider } from './memory-provider';
import { OpfsProvider } from './opfs-provider';
import { DialogProvider } from './dialog-provider';

export interface CreateStorageOptions extends StorageConfig {
  mode: FilesystemMode;
}

/**
 * Create a storage provider based on the configured mode.
 *
 * Modes:
 * - 'auto': OPFS if available, falls back to memory
 * - 'opfs': OPFS only (throws if unavailable)
 * - 'memory': In-memory only (no persistence)
 * - 'dialog': OPFS base + file dialogs for create_by_prompt
 */
export async function createStorageProvider(
  options: CreateStorageOptions
): Promise<StorageProvider> {
  const { mode, storyId } = options;
  const config: StorageConfig = { storyId };

  switch (mode) {
    case 'memory':
      console.log('[storage] Using memory provider (no persistence)');
      return new MemoryProvider(config);

    case 'opfs':
      if (!OpfsProvider.isAvailable()) {
        throw new Error(
          'OPFS is not available in this environment. ' +
          'Use filesystem: "auto" for automatic fallback or "memory" for in-memory storage.'
        );
      }
      console.log('[storage] Using OPFS provider');
      return new OpfsProvider(config);

    case 'dialog':
      if (!OpfsProvider.isAvailable()) {
        throw new Error(
          'Dialog mode requires OPFS for base storage, but OPFS is not available. ' +
          'Use filesystem: "auto" or "memory" instead.'
        );
      }
      console.log('[storage] Using dialog provider (OPFS + file dialogs)');
      return new DialogProvider(config);

    case 'auto':
    default:
      if (OpfsProvider.isAvailable()) {
        console.log('[storage] Auto-selected OPFS provider');
        return new OpfsProvider(config);
      }
      console.log('[storage] Auto-selected memory provider (OPFS not available)');
      return new MemoryProvider(config);
  }
}

/**
 * Check if a provider is dialog-capable.
 */
export function isDialogProvider(provider: StorageProvider): provider is DialogProvider {
  return provider instanceof DialogProvider;
}
