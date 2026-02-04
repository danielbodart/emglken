/**
 * WasiGlk Client
 *
 * Runs IF interpreters in a Web Worker using JSPI for async I/O.
 */

import { BlorbParser } from './blorb';
import { detectFormat, type FormatInfo, type StoryFormat } from './format';
import { type ClientUpdate, parseRemGlkUpdate } from './protocol';
import type { MainToWorkerMessage, WorkerToMainMessage } from './worker/messages';

export interface ClientConfig {
  /** URL to the story file */
  storyUrl?: string;
  /** Story file data (alternative to storyUrl) */
  storyData?: Uint8Array;
  /** URL to the interpreter WASM module (auto-detected if not provided) */
  interpreterUrl?: string;
  /** Interpreter WASM data (alternative to interpreterUrl) */
  interpreterData?: ArrayBuffer;
  /** Override format detection */
  format?: StoryFormat;
  /** URL to the worker script (required) */
  workerUrl: string | URL;
}

export interface UpdatesConfig {
  width: number;
  height: number;
  charWidth?: number;
  charHeight?: number;
}

export class WasiGlkClient {
  private storyData: Uint8Array;
  private interpreterData: ArrayBuffer;
  private formatInfo: FormatInfo;
  private blorb: BlorbParser | null = null;
  private worker: Worker | null = null;
  private running = false;
  private pendingUpdates: ClientUpdate[] = [];
  private updateResolve: ((value: IteratorResult<ClientUpdate>) => void) | null = null;
  private workerUrl: string | URL;
  private storyId: string;

  private constructor(
    storyData: Uint8Array,
    interpreterData: ArrayBuffer,
    formatInfo: FormatInfo,
    blorb: BlorbParser | null,
    workerUrl: string | URL,
    storyId: string
  ) {
    this.storyData = storyData;
    this.interpreterData = interpreterData;
    this.formatInfo = formatInfo;
    this.blorb = blorb;
    this.workerUrl = workerUrl;
    this.storyId = storyId;
  }

  static async create(config: ClientConfig): Promise<WasiGlkClient> {
    // Load story
    let storyData: Uint8Array;
    let storyUrl: string | null = null;

    if (config.storyData) {
      storyData = config.storyData;
    } else if (config.storyUrl) {
      storyUrl = config.storyUrl;
      const response = await fetch(config.storyUrl);
      if (!response.ok) throw new Error(`Failed to load story: ${response.status}`);
      storyData = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error('Either storyUrl or storyData must be provided');
    }

    // Detect format
    const formatInfo = config.format
      ? { format: config.format, interpreter: getInterpreterName(config.format), isBlorb: false }
      : detectFormat(storyUrl, storyData);

    // Parse Blorb
    let blorb: BlorbParser | null = null;
    let executableData = storyData;

    if (formatInfo.isBlorb || BlorbParser.isBlorb(storyData)) {
      blorb = new BlorbParser(storyData);
      const exec = blorb.getExecutable();
      if (exec) {
        executableData = exec.data;
        if (exec.type === 'GLUL') {
          formatInfo.format = 'glulx';
          formatInfo.interpreter = 'glulxe';
        } else if (exec.type === 'ZCOD') {
          formatInfo.format = 'zcode';
          formatInfo.interpreter = 'bocfel';
        }
      }
    }

    // Load interpreter
    let interpreterData: ArrayBuffer;
    if (config.interpreterData) {
      interpreterData = config.interpreterData;
    } else {
      const interpreterUrl = config.interpreterUrl ?? `/${formatInfo.interpreter}.wasm`;
      const response = await fetch(interpreterUrl);
      if (!response.ok) throw new Error(`Failed to load interpreter: ${response.status}`);
      interpreterData = await response.arrayBuffer();
    }

    // Generate story ID for save isolation
    const storyId = storyUrl
      ? storyUrl.replace(/[^a-zA-Z0-9]/g, '_')
      : `story_${hashBytes(storyData).toString(16)}`;

    return new WasiGlkClient(executableData, interpreterData, formatInfo, blorb, config.workerUrl, storyId);
  }

  get format(): FormatInfo {
    return this.formatInfo;
  }

  getBlorb(): BlorbParser | null {
    return this.blorb;
  }

  getImageUrl(imageNum: number): string | undefined {
    return this.blorb?.getImageUrl(imageNum);
  }

  sendInput(value: string): void {
    this.worker?.postMessage({ type: 'input', value } satisfies MainToWorkerMessage);
  }

  sendChar(char: string): void {
    this.sendInput(char);
  }

  /**
   * Send an arrange event to notify the interpreter of window resize.
   * This should be called when the display dimensions change.
   */
  sendArrange(metrics: UpdatesConfig): void {
    this.worker?.postMessage({
      type: 'arrange',
      metrics: {
        width: metrics.width,
        height: metrics.height,
        charWidth: metrics.charWidth,
        charHeight: metrics.charHeight,
      },
    } satisfies MainToWorkerMessage);
  }

  /**
   * Send a mouse click event to the interpreter.
   * This should be called when the user clicks in a window that has requested mouse input.
   * @param windowId - The ID of the window that was clicked
   * @param x - The x coordinate of the click (in window-relative units)
   * @param y - The y coordinate of the click (in window-relative units)
   */
  sendMouse(windowId: number, x: number, y: number): void {
    this.worker?.postMessage({
      type: 'mouse',
      windowId,
      x,
      y,
    } satisfies MainToWorkerMessage);
  }

  /**
   * Send a hyperlink click event to the interpreter.
   * This should be called when the user clicks a hyperlink in a window that has requested hyperlink input.
   * @param windowId - The ID of the window containing the hyperlink
   * @param linkValue - The link value (number) that was set with glk_set_hyperlink
   */
  sendHyperlink(windowId: number, linkValue: number): void {
    this.worker?.postMessage({
      type: 'hyperlink',
      windowId,
      linkValue,
    } satisfies MainToWorkerMessage);
  }

  /**
   * Send a redraw request to the interpreter.
   * This notifies the game that a graphics window needs to be redrawn.
   * @param windowId - Optional window ID. If omitted, all graphics windows need redrawing.
   */
  sendRedraw(windowId?: number): void {
    this.worker?.postMessage({
      type: 'redraw',
      windowId,
    } satisfies MainToWorkerMessage);
  }

  stop(): void {
    this.running = false;
    this.blorb?.dispose();
    if (this.worker) {
      this.worker.postMessage({ type: 'stop' } satisfies MainToWorkerMessage);
      this.worker.terminate();
      this.worker = null;
    }
    if (this.updateResolve) {
      this.updateResolve({ value: undefined as any, done: true });
      this.updateResolve = null;
    }
  }

  async *updates(config: UpdatesConfig): AsyncIterableIterator<ClientUpdate> {
    if (this.running) throw new Error('Client is already running');
    this.running = true;

    try {
      this.worker = new Worker(this.workerUrl, { type: 'module' });

      this.worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
        this.handleWorkerMessage(e.data);
      };

      this.worker.onerror = (e: ErrorEvent) => {
        this.pendingUpdates.push({ type: 'error', message: e.message || 'Worker error' });
        this.resolveNextUpdate();
      };

      const initMessage: MainToWorkerMessage = {
        type: 'init',
        interpreter: this.interpreterData,
        story: this.storyData,
        args: [this.formatInfo.interpreter, 'story.ulx'],
        metrics: config,
        storyId: this.storyId,
      };
      this.worker.postMessage(initMessage, [this.interpreterData]);

      while (this.running) {
        if (this.pendingUpdates.length > 0) {
          yield this.pendingUpdates.shift()!;
        } else {
          const result = await new Promise<IteratorResult<ClientUpdate>>(resolve => {
            this.updateResolve = resolve;
            if (!this.running) resolve({ value: undefined as any, done: true });
          });
          if (result.done) break;
          yield result.value;
        }
      }
    } finally {
      this.running = false;
      this.worker?.terminate();
      this.worker = null;
    }
  }

  private handleWorkerMessage(msg: WorkerToMainMessage): void {
    switch (msg.type) {
      case 'update':
        for (const update of parseRemGlkUpdate(msg.data, n => this.blorb?.getImageUrl(n))) {
          this.pendingUpdates.push(update);
        }
        this.resolveNextUpdate();
        break;
      case 'error':
        this.pendingUpdates.push({ type: 'error', message: msg.message });
        this.resolveNextUpdate();
        break;
      case 'exit':
        this.running = false;
        this.resolveNextUpdate();
        break;
    }
  }

  private resolveNextUpdate(): void {
    if (!this.updateResolve) return;
    const resolve = this.updateResolve;
    this.updateResolve = null;
    if (this.pendingUpdates.length > 0) {
      resolve({ value: this.pendingUpdates.shift()!, done: false });
    } else if (!this.running) {
      resolve({ value: undefined as any, done: true });
    }
  }
}

function getInterpreterName(format: StoryFormat): string {
  const names: Record<string, string> = {
    glulx: 'glulxe', zcode: 'bocfel', hugo: 'hugo', tads2: 'tads', tads3: 'tads',
  };
  return names[format] ?? 'glulxe';
}

function hashBytes(data: Uint8Array): number {
  let hash = 0;
  for (let i = 0; i < Math.min(data.length, 1024); i++) {
    hash = ((hash << 5) - hash + data[i]) | 0;
  }
  return hash >>> 0;
}

export async function createClient(config: ClientConfig): Promise<WasiGlkClient> {
  return WasiGlkClient.create(config);
}
