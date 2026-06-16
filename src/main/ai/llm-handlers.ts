/**
 * LLM IPC Handlers for Constella Desktop
 * Handles communication between renderer and main process for LLM functionality
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { LLMService, ChatMessage, ModelStatus, MemoryUsage } from './llm';
import { LLMConfig, ModelConfig, MODEL_REGISTRY, getRecommendedModel, getModelById } from './llm-config';
import { DownloadProgress } from './llm-download';
import { setupStellaLLMIntegration, updateStellaLLMService } from './stella-llm-integration';
import { getLLMSettingsManager, LLMSettings } from './llm-settings';
import { ToolCall, ToolResult, ToolExecutionContext } from './llm-tools';
import { markInteractiveActivity } from '../providers/runner';

let llmService: LLMService | null = null;

/**
 * Initialize LLM service singleton
 */
const getLLMService = (): LLMService => {
  if (!llmService) {
    llmService = new LLMService();
  }
  return llmService;
};

/**
 * Setup all LLM-related IPC handlers
 */
export const setupLLMHandlers = () => {
  console.log('Setting up LLM IPC handlers...');

  // Service Management
  ipcMain.handle('llm-initialize', async (_event: IpcMainInvokeEvent): Promise<boolean> => {
    try {
      const service = getLLMService();
      await service.initialize();
      return true;
    } catch (error) {
      console.error('LLM initialization failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-is-ready', async (_event: IpcMainInvokeEvent): Promise<boolean> => {
    try {
      const service = getLLMService();
      return service.isReady();
    } catch (error) {
      console.error('LLM ready check failed:', error);
      return false;
    }
  });

  ipcMain.handle('llm-get-capabilities', async (_event: IpcMainInvokeEvent) => {
    try {
      const service = getLLMService();
      return service.getCapabilities();
    } catch (error) {
      console.error('LLM capabilities check failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-cleanup', async (_event: IpcMainInvokeEvent): Promise<void> => {
    try {
      if (llmService) {
        await llmService.cleanup();
        llmService = null;
      }
    } catch (error) {
      console.error('LLM cleanup failed:', error);
      throw error;
    }
  });

  // Model Management
  ipcMain.handle('llm-get-model-registry', async (_event: IpcMainInvokeEvent): Promise<ModelConfig[]> => {
    return MODEL_REGISTRY;
  });

  ipcMain.handle('llm-get-recommended-model', async (_event: IpcMainInvokeEvent): Promise<ModelConfig> => {
    return getRecommendedModel();
  });

  ipcMain.handle('llm-get-model-by-id', async (_event: IpcMainInvokeEvent, { modelId }: { modelId: string }): Promise<ModelConfig | null> => {
    return getModelById(modelId) || null;
  });

  ipcMain.handle('llm-get-model-status', async (_event: IpcMainInvokeEvent): Promise<ModelStatus> => {
    try {
      const service = getLLMService();
      return service.getModelStatus();
    } catch (error) {
      console.error('LLM model status check failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-load-model', async (_event: IpcMainInvokeEvent, { modelId, options }: { modelId: string, options?: Partial<LLMConfig> }): Promise<ModelStatus> => {
    try {
      const service = getLLMService();
      const model = getModelById(modelId);
      
      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      const result = await service.loadModel(model, options);
      
      // Update Stella integration with the ready LLM service
      updateStellaLLMService(service);
      
      return result;
    } catch (error) {
      console.error('LLM model loading failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-unload-model', async (_event: IpcMainInvokeEvent): Promise<boolean> => {
    try {
      const service = getLLMService();
      return await service.unloadModel();
    } catch (error) {
      console.error('LLM model unloading failed:', error);
      throw error;
    }
  });

  // Download Management
  ipcMain.handle('llm-is-model-downloaded', async (_event: IpcMainInvokeEvent, { modelId }: { modelId: string }): Promise<boolean> => {
    try {
      const service = getLLMService();
      const model = getModelById(modelId);
      
      if (!model) {
        return false;
      }

      return await service.getDownloadService().isModelDownloaded(model.filename);
    } catch (error) {
      console.error('LLM model download check failed:', error);
      return false;
    }
  });

  ipcMain.handle('llm-start-download', async (_event: IpcMainInvokeEvent, { modelId }: { modelId: string }): Promise<string> => {
    try {
      const service = getLLMService();
      const model = getModelById(modelId);
      
      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      return await service.getDownloadService().startDownload(model);
    } catch (error) {
      console.error('LLM download start failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-cancel-download', async (_event: IpcMainInvokeEvent, { downloadId }: { downloadId: string }): Promise<boolean> => {
    try {
      const service = getLLMService();
      return await service.getDownloadService().cancelDownload(downloadId);
    } catch (error) {
      console.error('LLM download cancel failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-get-download-progress', async (_event: IpcMainInvokeEvent, { downloadId }: { downloadId: string }): Promise<DownloadProgress | null> => {
    try {
      const service = getLLMService();
      return service.getDownloadService().getDownloadProgress(downloadId);
    } catch (error) {
      console.error('LLM download progress check failed:', error);
      return null;
    }
  });

  ipcMain.handle('llm-get-active-downloads', async (_event: IpcMainInvokeEvent): Promise<DownloadProgress[]> => {
    try {
      const service = getLLMService();
      return service.getDownloadService().getActiveDownloads();
    } catch (error) {
      console.error('LLM active downloads check failed:', error);
      return [];
    }
  });

  ipcMain.handle('llm-get-downloaded-models', async (_event: IpcMainInvokeEvent): Promise<string[]> => {
    try {
      const service = getLLMService();
      return await service.getDownloadService().getDownloadedModels();
    } catch (error) {
      console.error('LLM downloaded models check failed:', error);
      return [];
    }
  });

  ipcMain.handle('llm-delete-model', async (_event: IpcMainInvokeEvent, { filename }: { filename: string }): Promise<boolean> => {
    try {
      const service = getLLMService();
      return await service.getDownloadService().deleteModel(filename);
    } catch (error) {
      console.error('LLM model deletion failed:', error);
      throw error;
    }
  });

  // Chat Management
  ipcMain.handle('llm-create-chat-session', async (_event: IpcMainInvokeEvent, { systemPrompt, enableTools = false }: { systemPrompt?: string, enableTools?: boolean }): Promise<boolean> => {
    try {
      const service = getLLMService();
      return await service.createChatSession(systemPrompt, enableTools);
    } catch (error) {
      console.error('LLM chat session creation failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-clear-chat-session', async (_event: IpcMainInvokeEvent): Promise<boolean> => {
    try {
      const service = getLLMService();
      return await service.clearChatSession();
    } catch (error) {
      console.error('LLM chat session clear failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-send-message', async (_event: IpcMainInvokeEvent, { message, options, enableTools = false }: { message: string, options?: Partial<LLMConfig>, enableTools?: boolean }) => {
    try {
      const service = getLLMService();
      return await service.sendMessage(message, options, enableTools);
    } catch (error) {
      console.error('LLM message send failed:', error);
      throw error;
    }
  });

  // Streaming chat is handled differently - we'll use events for real-time streaming
  ipcMain.handle('llm-stream-message', async (event: IpcMainInvokeEvent, { message, options, enableTools = false }: { message: string, options?: Partial<LLMConfig>, enableTools?: boolean }): Promise<string> => {
    try {
      const service = getLLMService();
      let responseId = `stream-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
      
      // Interactive chat — keep the worker reserved for the user so the
      // background file-graph engine yields (marked again per token below so a
      // long stream stays "active" past the 4s cooldown).
      markInteractiveActivity();

      // Start streaming in background
      (async () => {
        try {
          for await (const token of service.streamMessage(message, options, enableTools)) {
            markInteractiveActivity();
            event.sender.send('llm-stream-token', {
              responseId,
              token
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          event.sender.send('llm-stream-error', {
            responseId,
            error: errorMessage
          });
        }
      })();

      return responseId;
    } catch (error) {
      console.error('LLM message stream failed:', error);
      throw error;
    }
  });

  // Configuration Management
  ipcMain.handle('llm-get-config', async (_event: IpcMainInvokeEvent): Promise<LLMConfig> => {
    try {
      const service = getLLMService();
      return service.getConfig();
    } catch (error) {
      console.error('LLM config get failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-update-config', async (_event: IpcMainInvokeEvent, { newConfig }: { newConfig: Partial<LLMConfig> }): Promise<void> => {
    try {
      const service = getLLMService();
      service.updateConfig(newConfig);
    } catch (error) {
      console.error('LLM config update failed:', error);
      throw error;
    }
  });

  // System Information
  ipcMain.handle('llm-get-memory-usage', async (_event: IpcMainInvokeEvent): Promise<MemoryUsage> => {
    try {
      const service = getLLMService();
      return await service.getMemoryUsage();
    } catch (error) {
      console.error('LLM memory usage check failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-get-models-directory', async (_event: IpcMainInvokeEvent): Promise<string> => {
    try {
      const service = getLLMService();
      return service.getDownloadService().getModelsDirectory();
    } catch (error) {
      console.error('LLM models directory check failed:', error);
      throw error;
    }
  });

  // Settings Management
  ipcMain.handle('llm-settings-initialize', async (_event: IpcMainInvokeEvent): Promise<void> => {
    try {
      const settingsManager = getLLMSettingsManager();
      await settingsManager.initialize();
    } catch (error) {
      console.error('LLM settings initialization failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-settings-get', async (_event: IpcMainInvokeEvent): Promise<LLMSettings> => {
    try {
      const settingsManager = getLLMSettingsManager();
      return settingsManager.getSettings();
    } catch (error) {
      console.error('LLM settings get failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-settings-update', async (_event: IpcMainInvokeEvent, { updates }: { updates: Partial<LLMSettings> }): Promise<void> => {
    try {
      const settingsManager = getLLMSettingsManager();
      await settingsManager.updateSettings(updates);
    } catch (error) {
      console.error('LLM settings update failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-settings-reset', async (_event: IpcMainInvokeEvent): Promise<void> => {
    try {
      const settingsManager = getLLMSettingsManager();
      await settingsManager.resetSettings();
    } catch (error) {
      console.error('LLM settings reset failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-settings-export', async (_event: IpcMainInvokeEvent): Promise<string> => {
    try {
      const settingsManager = getLLMSettingsManager();
      return settingsManager.exportSettings();
    } catch (error) {
      console.error('LLM settings export failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-settings-import', async (_event: IpcMainInvokeEvent, { settingsJson }: { settingsJson: string }): Promise<void> => {
    try {
      const settingsManager = getLLMSettingsManager();
      await settingsManager.importSettings(settingsJson);
    } catch (error) {
      console.error('LLM settings import failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-settings-get-summary', async (_event: IpcMainInvokeEvent): Promise<Record<string, any>> => {
    try {
      const settingsManager = getLLMSettingsManager();
      return settingsManager.getSettingsSummary();
    } catch (error) {
      console.error('LLM settings summary failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { error: errorMessage };
    }
  });

  // ============= Tool Calling Handlers =============

  ipcMain.handle('llm-set-tools-enabled', async (_event: IpcMainInvokeEvent, { enabled }: { enabled: boolean }): Promise<void> => {
    try {
      const service = getLLMService();
      service.setToolsEnabled(enabled);
    } catch (error) {
      console.error('LLM set tools enabled failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-is-tools-enabled', async (_event: IpcMainInvokeEvent): Promise<boolean> => {
    try {
      const service = getLLMService();
      return service.isToolsEnabled();
    } catch (error) {
      console.error('LLM is tools enabled check failed:', error);
      return false;
    }
  });

  ipcMain.handle('llm-set-tool-execution-context', async (_event: IpcMainInvokeEvent, { context }: { context: ToolExecutionContext }): Promise<void> => {
    try {
      const service = getLLMService();
      service.setToolExecutionContext(context);
    } catch (error) {
      console.error('LLM set tool execution context failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-get-available-tools', async (_event: IpcMainInvokeEvent) => {
    try {
      const service = getLLMService();
      return service.getAvailableTools();
    } catch (error) {
      console.error('LLM get available tools failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-execute-tool-call', async (_event: IpcMainInvokeEvent, { toolCall }: { toolCall: ToolCall }): Promise<ToolResult> => {
    try {
      const service = getLLMService();
      return await service.executeToolCall(toolCall);
    } catch (error) {
      console.error('LLM execute tool call failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-execute-tool-calls', async (_event: IpcMainInvokeEvent, { toolCalls }: { toolCalls: ToolCall[] }): Promise<ToolResult[]> => {
    try {
      const service = getLLMService();
      return await service.executeToolCalls(toolCalls);
    } catch (error) {
      console.error('LLM execute tool calls failed:', error);
      throw error;
    }
  });

  ipcMain.handle('llm-get-tool-execution-stats', async (_event: IpcMainInvokeEvent) => {
    try {
      const service = getLLMService();
      return service.getToolExecutionStats();
    } catch (error) {
      console.error('LLM get tool execution stats failed:', error);
      throw error;
    }
  });

  // Event forwarding - forward LLM service events to renderer
  const service = getLLMService();
  
  service.on('initialized', (data) => {
    ipcMain.emit('llm-initialized', data);
  });

  service.on('modelLoaded', (data) => {
    ipcMain.emit('llm-model-loaded', data);
  });

  service.on('modelUnloaded', () => {
    ipcMain.emit('llm-model-unloaded');
  });

  service.on('sessionCreated', () => {
    ipcMain.emit('llm-session-created');
  });

  service.on('sessionCleared', () => {
    ipcMain.emit('llm-session-cleared');
  });

  service.on('configUpdated', (config) => {
    ipcMain.emit('llm-config-updated', config);
  });

  service.on('toolsToggled', (data) => {
    ipcMain.emit('llm-tools-toggled', data);
  });

  service.on('toolCallsExecuted', (data) => {
    ipcMain.emit('llm-tool-calls-executed', data);
  });

  // Forward download events
  service.getDownloadService().on('progress', (progress) => {
    ipcMain.emit('llm-download-progress', progress);
  });

  service.getDownloadService().on('completed', (info) => {
    ipcMain.emit('llm-download-completed', info);
  });

  service.getDownloadService().on('error', (error) => {
    ipcMain.emit('llm-download-error', error);
  });

  service.getDownloadService().on('cancelled', (info) => {
    ipcMain.emit('llm-download-cancelled', info);
  });

  // Setup Stella-LLM integration
  setupStellaLLMIntegration(llmService || undefined);

  console.log('✅ LLM IPC handlers setup completed');
};

/**
 * Cleanup LLM handlers (call on app quit)
 */
export const cleanupLLMHandlers = async (): Promise<void> => {
  if (llmService) {
    await llmService.cleanup();
    llmService = null;
  }
};