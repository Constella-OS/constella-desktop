/**
 * LLM Service for Constella Desktop
 * Handles model loading, inference, and chat sessions using node-llama-cpp
 */

// Dynamic import for ES module compatibility
let nodeLlamaCpp: any = null;
import * as fs from 'fs-extra';
import * as path from 'path';
import { EventEmitter } from 'events';
import { LLMConfig, ModelConfig, validateConfig } from './llm-config';
import { LLMDownloadService } from './llm-download';
import {
  ToolManager,
  ToolCall,
  ToolResult,
  parseToolCallsFromResponse,
  extractConversationalText,
  ToolExecutionContext,
} from './llm-tools';
import { ToolExecutor } from './llm-tool-executor';
import { runLocal, warmLocalModel } from '../providers/localLlmClient';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ChatStreamToken {
  text: string;
  token: number;
  isComplete: boolean;
  tokensUsed?: number;
  inferenceTime?: number;
  memoryUsage?: MemoryUsage;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ChatResponse {
  response: string;
  tokensUsed: number;
  inferenceTime: number;
  memoryUsage: MemoryUsage;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  conversationalText?: string;
}

export interface MemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  model: number;
  context: number;
}

export interface ModelStatus {
  loaded: boolean;
  modelName: string | null;
  modelPath: string | null;
  contextSize: number;
  loadTime: number | null;
  gpuLayers: number | string;
  memoryUsage?: MemoryUsage;
}

/**
 * Load node-llama-cpp module dynamically
 * Using Function constructor to avoid TypeScript transpilation to require()
 */
const loadNodeLlamaCpp = async () => {
  if (!nodeLlamaCpp) {
    // Use Function constructor to create a true dynamic import that won't be transpiled
    const dynamicImport = new Function('specifier', 'return import(specifier)');
    nodeLlamaCpp = await dynamicImport('node-llama-cpp');
  }
  return nodeLlamaCpp;
};

/**
 * Main LLM Service class
 */
export class LLMService extends EventEmitter {
  private llama: any = null;
  private model: any = null;
  private context: any = null;
  private session: any = null;
  private currentSequence: any = null;

  private isInitialized = false;
  private modelInfo: any = null;
  private config: LLMConfig;
  private downloadService: LLMDownloadService;
  private toolManager: ToolManager;
  private toolExecutor: ToolExecutor;
  private toolsEnabled = false;

  // Facade state. The worker process (localLlmClient) owns the actual model in
  // a separate process, so this service NO LONGER loads a model in-process —
  // recall and the legacy direct-chat (StellaFullChat → llm-* IPC) now share
  // ONE copy of the model in RAM (the worker's). `selectedModelId` is the id
  // handed to the worker for warm/run; `modelInfo` backs getModelStatus/isReady.
  private selectedModelId: string | null = null;

  constructor(config: Partial<LLMConfig> = {}) {
    super();
    this.config = validateConfig(config);
    this.downloadService = new LLMDownloadService();
    this.toolManager = new ToolManager();
    this.toolExecutor = new ToolExecutor(this.toolManager);
  }

  /**
   * Initialize the llama.cpp instance with Metal acceleration
   */
  public async initialize(): Promise<void> {
    // Facade: the worker process owns node-llama-cpp + the model. We
    // deliberately do NOT create a main-process llama backend (or Metal device)
    // here — that's what would have produced a second model in RAM. Marking the
    // service initialized is enough; loadModel() warms the worker and the worker
    // lazy-loads on first run.
    this.isInitialized = true;
    console.log('LLM service initialized (worker-backed facade)');
    this.emit('initialized', {
      hasGPU: this.config.enableMetal && process.platform === 'darwin',
      gpuType:
        this.config.enableMetal && process.platform === 'darwin'
          ? 'metal'
          : null,
    });
  }

  /**
   * Load a model from file path or model config
   */
  public async loadModel(
    modelPathOrConfig: string | ModelConfig,
    _options: Partial<LLMConfig> = {},
  ): Promise<ModelStatus> {
    // Facade: "loading" means warming the model in the WORKER (the only process
    // that holds it), then recording selection + status here. No model is loaded
    // in the main process, so recall + direct chat share one in-RAM copy.
    let modelId: string | undefined;
    let modelName: string;
    let modelPath: string;

    if (typeof modelPathOrConfig === 'string') {
      // Raw path (legacy/manual): no registry id, so the worker falls back to
      // the recommended model. Kept for API compatibility.
      modelPath = modelPathOrConfig;
      modelName = path.basename(modelPath);
    } else {
      modelId = modelPathOrConfig.id;
      modelName = modelPathOrConfig.name;
      modelPath = this.downloadService.getModelPath(modelPathOrConfig.filename);
      if (
        !(await this.downloadService.isModelDownloaded(
          modelPathOrConfig.filename,
        ))
      ) {
        throw new Error(`Model not downloaded: ${modelPathOrConfig.filename}`);
      }
    }

    try {
      console.log(`Warming model in worker: ${modelName}`);
      const startTime = Date.now();
      const warmed = await warmLocalModel(modelId);
      if (!warmed) {
        throw new Error(
          'No local model available to load (file not downloaded).',
        );
      }

      this.selectedModelId = modelId ?? null;
      this.modelInfo = {
        path: modelPath,
        filename: path.basename(modelPath),
        name: modelName,
        // The worker auto-fits the context up to the model's configured size
        // (e.g. Qwen3 = 32768). Reflect that here for status accuracy instead
        // of the old hard-coded 4096.
        contextSize:
          typeof modelPathOrConfig === 'string'
            ? 8192
            : modelPathOrConfig.contextSize,
        loaded: true,
        loadTime: Date.now() - startTime,
        gpuLayers:
          this.config.enableMetal && process.platform === 'darwin' ? 'auto' : 0,
      };

      console.log('Model ready in worker:', modelName);
      this.emit('modelLoaded', this.modelInfo);
      return this.getModelStatus();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('Failed to load (warm) model:', error);
      throw new Error(`Model loading failed: ${errorMessage}`);
    }
  }

  /**
   * Create a new chat session with optional tool calling support
   */
  public async createChatSession(
    _systemPrompt?: string,
    _enableTools = false,
  ): Promise<boolean> {
    // Facade: the worker is stateless (one-shot per message) and the renderer
    // owns conversation history in its assembled prompt, so there's no
    // in-process LlamaChatSession to create. Kept for IPC compatibility.
    this.emit('sessionCreated');
    return true;
  }

  /**
   * Send a message and get response (non-streaming) with tool calling support
   */
  public async sendMessage(
    message: string,
    _options: Partial<LLMConfig> = {},
    _enableTools = false,
  ): Promise<ChatResponse> {
    // Delegate to the worker (one-shot). Tool-calling is not supported on the
    // worker path; the only live caller (StellaFullChat) doesn't use tools.
    try {
      const startTime = Date.now();
      let assembled = '';
      const { promise } = runLocal(
        { prompt: message, modelId: this.selectedModelId ?? undefined },
        (text) => {
          assembled += text;
        },
      );
      const r = await promise;
      const response = r.text || assembled;
      return {
        response,
        tokensUsed: this.estimateTokenCount(response),
        inferenceTime: (Date.now() - startTime) / 1000,
        memoryUsage: await this.getMemoryUsage(),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('Failed to send message:', error);
      throw new Error(`Message processing failed: ${errorMessage}`);
    }
  }

  /**
   * Send a message with streaming response and tool calling support
   */
  public async *streamMessage(
    message: string,
    _options: Partial<LLMConfig> = {},
    _enableTools = false,
  ): AsyncGenerator<ChatStreamToken> {
    const startTime = Date.now();

    // Bridge the worker's onToken callback (push) into this generator (pull):
    // tokens land in a queue; the loop drains it and parks on `wake` when empty.
    const queue: string[] = [];
    let finished = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    const ping = () => {
      if (wake) {
        const w = wake;
        wake = null;
        w();
      }
    };

    const { promise } = runLocal(
      { prompt: message, modelId: this.selectedModelId ?? undefined },
      (text) => {
        queue.push(text);
        ping();
      },
    );
    promise
      .then(() => {
        finished = true;
        ping();
      })
      .catch((e) => {
        failure = e instanceof Error ? e : new Error(String(e));
        finished = true;
        ping();
      });

    let tokenNum = 0;
    let assembled = '';
    // Drain tokens as they stream; park when the queue is empty and not done.
    while (true) {
      if (queue.length > 0) {
        const text = queue.shift() as string;
        assembled += text;
        tokenNum += 1;
        yield { text, token: tokenNum, isComplete: false };
        continue;
      }
      if (finished) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }

    if (failure) {
      const err = failure as Error;
      console.error('Failed to stream message:', err);
      throw new Error(`Message streaming failed: ${err.message}`);
    }

    // Final completion token (mirrors the legacy contract the renderer expects).
    yield {
      text: '',
      token: 0,
      isComplete: true,
      tokensUsed: this.estimateTokenCount(assembled),
      inferenceTime: (Date.now() - startTime) / 1000,
      memoryUsage: await this.getMemoryUsage(),
    };
  }

  /**
   * Clear the current chat session
   */
  public async clearChatSession(): Promise<boolean> {
    // The worker runs one-shot per message; conversation history lives in the
    // renderer's assembled prompt. There's no in-process session to clear.
    this.session = null;
    this.emit('sessionCleared');
    return true;
  }

  /**
   * Get current model status
   */
  public getModelStatus(): ModelStatus {
    if (!this.modelInfo) {
      return {
        loaded: false,
        modelName: null,
        modelPath: null,
        contextSize: 0,
        loadTime: null,
        gpuLayers: 0,
      };
    }

    return {
      loaded: true,
      modelName: this.modelInfo.name,
      modelPath: this.modelInfo.path,
      contextSize: this.modelInfo.contextSize,
      loadTime: this.modelInfo.loadTime,
      gpuLayers: this.modelInfo.gpuLayers,
    };
  }

  /**
   * Get system memory usage information
   */
  public async getMemoryUsage(): Promise<MemoryUsage> {
    try {
      const usage = process.memoryUsage();
      return {
        rss: usage.rss,
        heapTotal: usage.heapTotal,
        heapUsed: usage.heapUsed,
        external: usage.external,
        model: this.model ? this.estimateModelMemory() : 0,
        context: this.context ? this.estimateContextMemory() : 0,
      };
    } catch (error) {
      console.error('Failed to get memory usage:', error);
      return {
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        model: 0,
        context: 0,
      };
    }
  }

  /**
   * Update configuration
   */
  public updateConfig(newConfig: Partial<LLMConfig>): void {
    this.config = validateConfig({ ...this.config, ...newConfig });
    this.emit('configUpdated', this.config);
  }

  /**
   * Get current configuration
   */
  public getConfig(): LLMConfig {
    return { ...this.config };
  }

  /**
   * Get download service instance
   */
  public getDownloadService(): LLMDownloadService {
    return this.downloadService;
  }

  /**
   * Unload current model and free memory
   */
  public async unloadModel(): Promise<boolean> {
    // We don't hold a model in-process; just drop the selection + status. The
    // worker keeps its cached model (recall may still be using it) — it's freed
    // when the worker process is stopped on app quit (stopProviders).
    this.session = null;
    this.selectedModelId = null;
    this.modelInfo = null;
    this.emit('modelUnloaded');
    return true;
  }

  /**
   * Service cleanup
   */
  public async cleanup(): Promise<void> {
    console.log('Cleaning up LLM service...');

    try {
      await this.unloadModel();
      await this.downloadService.cleanup();

      if (this.llama) {
        // Dispose llama instance if it has cleanup methods
        if (typeof this.llama.dispose === 'function') {
          await this.llama.dispose();
        }
        this.llama = null;
      }

      // Cleanup tool executor
      if (this.toolExecutor) {
        this.toolExecutor.cleanup();
      }

      this.isInitialized = false;
      this.toolsEnabled = false;
      console.log('LLM service cleanup completed');
    } catch (error: unknown) {
      console.error('Error during LLM service cleanup:', error);
    }
  }

  /**
   * Check if service is ready for inference
   */
  public isReady(): boolean {
    // Ready once a model has been selected + warmed in the worker. We no longer
    // hold a model/context in-process, so readiness keys off modelInfo.
    return this.isInitialized && !!this.modelInfo;
  }

  /**
   * Get service capabilities
   */
  public getCapabilities() {
    return {
      initialized: this.isInitialized,
      hasModel: !!this.modelInfo,
      hasGPU: this.config.enableMetal && process.platform === 'darwin',
      gpuType:
        this.config.enableMetal && process.platform === 'darwin'
          ? 'metal'
          : null,
      supportedFormats: ['gguf'],
      maxContextSize: 32768,
      streaming: true,
      toolCalling: {
        supported: true,
        enabled: this.toolsEnabled,
        availableTools: this.toolManager.getTools().length,
        executorReady: this.toolExecutor.isReady(),
      },
    };
  }

  /**
   * Estimate model memory usage (approximation)
   */
  private estimateModelMemory(): number {
    if (!this.modelInfo) return 0;
    try {
      const stats = fs.statSync(this.modelInfo.path);
      return stats.size;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Estimate context memory usage (approximation)
   */
  private estimateContextMemory(): number {
    if (!this.context || !this.modelInfo) return 0;
    // Rough estimate: context size * 4 bytes per token * 2 (key + value)
    return this.modelInfo.contextSize * 4 * 2;
  }

  /**
   * Estimate token count for a text string (approximation)
   */
  private estimateTokenCount(text: string): number {
    if (!text) return 0;
    // Rough estimate: ~4 characters per token for English text
    return Math.ceil(text.length / 4);
  }

  // ============= Tool Calling Methods =============

  /**
   * Enable or disable tool calling support
   */
  public setToolsEnabled(enabled: boolean): void {
    this.toolsEnabled = enabled;
    console.log(`Tool calling ${enabled ? 'enabled' : 'disabled'}`);
    this.emit('toolsToggled', { enabled });
  }

  /**
   * Check if tools are enabled
   */
  public isToolsEnabled(): boolean {
    return this.toolsEnabled;
  }

  /**
   * Set the tool execution context
   */
  public setToolExecutionContext(context: ToolExecutionContext): void {
    this.toolExecutor.setExecutionContext(context);
    console.log('Tool execution context updated');
  }

  /**
   * Get the tool manager instance
   */
  public getToolManager(): ToolManager {
    return this.toolManager;
  }

  /**
   * Get the tool executor instance
   */
  public getToolExecutor(): ToolExecutor {
    return this.toolExecutor;
  }

  /**
   * Get available tools
   */
  public getAvailableTools() {
    return this.toolManager.getTools();
  }

  /**
   * Execute a tool call manually
   */
  public async executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
    return await this.toolExecutor.executeTool(toolCall);
  }

  /**
   * Execute multiple tool calls manually
   */
  public async executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return await this.toolExecutor.executeTools(toolCalls);
  }

  /**
   * Get tool execution statistics
   */
  public getToolExecutionStats() {
    return this.toolExecutor.getExecutionStats();
  }
}
