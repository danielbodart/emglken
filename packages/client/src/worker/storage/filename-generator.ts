/**
 * Filename Generator
 *
 * Generates deterministic filenames based on file type.
 * Used when auto-generating names for create_by_prompt in non-dialog modes.
 */

import type { FileType } from './types';

/** File extensions for each file type */
const EXTENSIONS: Record<FileType, string> = {
  save: 'glksave',
  transcript: 'txt',
  command: 'txt',
  data: 'glkdata',
};

/** Base filenames for each file type */
const BASENAMES: Record<FileType, string> = {
  save: 'save',
  transcript: 'transcript',
  command: 'commands',
  data: 'data',
};

/**
 * Get the file extension for a file type.
 */
export function getExtension(filetype: FileType | string): string {
  return EXTENSIONS[filetype as FileType] ?? 'glkdata';
}

/**
 * Generate a deterministic filename for a file type.
 *
 * Uses consistent names so save and restore operations work together:
 * - SavedGame -> save.glksave
 * - Transcript -> transcript.txt
 * - InputRecord -> commands.txt
 * - Data -> data.glkdata
 */
export function generateFilename(filetype: FileType | string): string {
  const basename = BASENAMES[filetype as FileType] ?? 'data';
  const ext = getExtension(filetype);
  return `${basename}.${ext}`;
}
