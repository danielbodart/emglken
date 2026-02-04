/**
 * Worker Message Types
 */

import type { RemGlkUpdate } from '../protocol';
import type { FilesystemMode } from './storage';

export type { FilesystemMode };

/** Metrics passed to the worker */
export interface WorkerMetrics {
  // Overall dimensions
  width: number;
  height: number;
  // Generic character dimensions
  charWidth?: number;
  charHeight?: number;
  // Outer/inner spacing
  outSpacingX?: number;
  outSpacingY?: number;
  inSpacingX?: number;
  inSpacingY?: number;
  // Grid window character dimensions and margins
  gridCharWidth?: number;
  gridCharHeight?: number;
  gridMarginX?: number;
  gridMarginY?: number;
  // Buffer window character dimensions and margins
  bufferCharWidth?: number;
  bufferCharHeight?: number;
  bufferMarginX?: number;
  bufferMarginY?: number;
  // Graphics window margins
  graphicsMarginX?: number;
  graphicsMarginY?: number;
}

/** Messages from main thread to worker */
export type MainToWorkerMessage =
  | { type: 'init'; interpreter: ArrayBuffer; story: Uint8Array; args: string[]; metrics: WorkerMetrics; storyId: string; filesystem: FilesystemMode }
  | { type: 'input'; value: string }
  | { type: 'arrange'; metrics: WorkerMetrics }
  | { type: 'mouse'; windowId: number; x: number; y: number }
  | { type: 'hyperlink'; windowId: number; linkValue: number }
  | { type: 'redraw'; windowId?: number }
  | { type: 'refresh' }
  | { type: 'stop' }
  // File dialog responses
  | { type: 'fileDialogResult'; filename: string | null; handle?: FileSystemFileHandle };

/** Supported file dialog modes */
export type FileDialogMode = 'read' | 'write' | 'readwrite' | 'writeappend';

/** Messages from worker to main thread */
export type WorkerToMainMessage =
  | { type: 'update'; data: RemGlkUpdate }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number }
  // File dialog request
  | { type: 'fileDialogRequest'; filemode: FileDialogMode; filetype: 'save' | 'data' | 'transcript' | 'command' };
