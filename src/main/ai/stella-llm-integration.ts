/**
 * Stella-LLM Integration Service
 * Bridges the local LLM service with Stella assistant functionality
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { LLMService } from './llm';
import { LLMConfig } from './llm-config';

interface StellaLLMProvider {
  name: string;
  type: 'local' | 'cloud';
  available: boolean;
  description: string;
}

interface StellaContext {
  notes?: any[];
  currentNote?: any;
  tags?: string[];
  searchQuery?: string;
  selectedText?: string;
  metadata?: Record<string, any>;
}

interface StellaRequest {
  message: string;
  context: StellaContext;
  systemPrompt?: string;
  provider?: 'local' | 'cloud' | 'auto';
  streamResponse?: boolean;
}

interface StellaResponse {
  response: string;
  provider: string;
  tokensUsed?: number;
  inferenceTime?: number;
  appliedChanges?: any[];
  suggestions?: string[];
}

/**
 * Integration service for Stella assistant with local LLM
 */
export class StellaLLMIntegration {
  private llmService: LLMService | null = null;
  private defaultProvider: 'local' | 'cloud' | 'auto' = 'auto';
  private localLLMEnabled = true;

  constructor(llmService?: LLMService) {
    this.llmService = llmService || null;
  }

  /**
   * Set the LLM service instance
   */
  public setLLMService(llmService: LLMService): void {
    this.llmService = llmService;
  }

  /**
   * Get available LLM providers for Stella
   */
  public getAvailableProviders(): StellaLLMProvider[] {
    const providers: StellaLLMProvider[] = [
      {
        name: 'Cloud (OpenAI/Anthropic)',
        type: 'cloud',
        available: true, // Assume cloud is always available
        description: 'High-quality responses using cloud-based models'
      }
    ];

    if (this.llmService && this.localLLMEnabled) {
      providers.unshift({
        name: 'Local LLM',
        type: 'local',
        available: this.llmService.isReady(),
        description: 'Privacy-focused local inference with your downloaded model'
      });
    }

    return providers;
  }

  /**
   * Set default provider preference
   */
  public setDefaultProvider(provider: 'local' | 'cloud' | 'auto'): void {
    this.defaultProvider = provider;
  }

  /**
   * Create enhanced system prompt for Stella with Constella context
   */
  private createStellaSystemPrompt(context: StellaContext): string {
    let systemPrompt = `You are Stella, an AI assistant integrated into Constella, a powerful note-taking and knowledge management application. Your role is to help users with their notes, ideas, research, and knowledge work.

Core Capabilities:
- Analyze and summarize notes and documents
- Generate insights and connections between ideas
- Help with writing, editing, and organizing content
- Suggest tags and categorization
- Answer questions about note content
- Provide research assistance and fact-checking

Current Context:`;

    if (context.notes && context.notes.length > 0) {
      systemPrompt += `\n- User has ${context.notes.length} notes in their current view`;
      if (context.notes.length <= 5) {
        systemPrompt += `\n- Note titles: ${context.notes.map(n => n.title || 'Untitled').join(', ')}`;
      }
    }

    if (context.currentNote) {
      systemPrompt += `\n- Currently viewing note: "${context.currentNote.title || 'Untitled'}"`;
      if (context.currentNote.content && context.currentNote.content.length > 0) {
        const preview = context.currentNote.content.slice(0, 200);
        systemPrompt += `\n- Note preview: "${preview}${context.currentNote.content.length > 200 ? '...' : ''}"`;
      }
    }

    if (context.tags && context.tags.length > 0) {
      systemPrompt += `\n- Active tags: ${context.tags.join(', ')}`;
    }

    if (context.selectedText) {
      systemPrompt += `\n- Selected text: "${context.selectedText}"`;
    }

    if (context.searchQuery) {
      systemPrompt += `\n- Current search: "${context.searchQuery}"`;
    }

    systemPrompt += `\n\nGuidelines:
- Be helpful, concise, and relevant to the user's note-taking workflow
- Suggest actionable improvements to their notes and organization
- When appropriate, recommend connections between notes or ideas
- Respect privacy - all information stays within the user's local environment
- If asked to modify notes, provide clear, specific suggestions
- Use markdown formatting when helpful for structure

Respond naturally and focus on being genuinely helpful with their knowledge work.`;

    return systemPrompt;
  }

  /**
   * Choose appropriate provider based on request and availability
   */
  private chooseProvider(request: StellaRequest): 'local' | 'cloud' {
    if (request.provider === 'local') {
      if (this.llmService && this.llmService.isReady()) {
        return 'local';
      }
      throw new Error('Local LLM not available. Please download and load a model first.');
    }

    if (request.provider === 'cloud') {
      return 'cloud';
    }

    // Auto selection
    if (this.defaultProvider === 'local' && this.llmService && this.llmService.isReady()) {
      return 'local';
    }

    if (this.defaultProvider === 'cloud') {
      return 'cloud';
    }

    // Auto fallback: prefer local if available, otherwise cloud
    if (this.llmService && this.llmService.isReady()) {
      return 'local';
    }

    return 'cloud';
  }

  /**
   * Process Stella request using appropriate provider
   */
  public async processRequest(request: StellaRequest): Promise<StellaResponse> {
    const provider = this.chooseProvider(request);

    if (provider === 'local') {
      return await this.processLocalRequest(request);
    } else {
      return await this.processCloudRequest(request);
    }
  }

  /**
   * Process request using local LLM
   */
  private async processLocalRequest(request: StellaRequest): Promise<StellaResponse> {
    if (!this.llmService || !this.llmService.isReady()) {
      throw new Error('Local LLM service not ready');
    }

    try {
      // Create enhanced system prompt with context
      const systemPrompt = request.systemPrompt || this.createStellaSystemPrompt(request.context);

      // Ensure chat session with Stella system prompt
      await this.llmService.createChatSession(systemPrompt);

      // Configure for Stella use case
      const stellaConfig: Partial<LLMConfig> = {
        temperature: 0.7, // Balanced creativity
        topP: 0.9,
        maxTokens: 2048, // Good length for assistant responses
      };

      // Send message
      const result = await this.llmService.sendMessage(request.message, stellaConfig);

      return {
        response: result.response,
        provider: 'local',
        tokensUsed: result.tokensUsed,
        inferenceTime: result.inferenceTime,
        appliedChanges: [], // TODO: Parse response for action items
        suggestions: [] // TODO: Extract suggestions from response
      };

    } catch (error) {
      console.error('Local LLM request failed:', error);
      throw error;
    }
  }

  /**
   * Process request using cloud provider (fallback to existing implementation)
   */
  private async processCloudRequest(request: StellaRequest): Promise<StellaResponse> {
    // This would integrate with the existing cloud-based Stella implementation
    // For now, return a placeholder that can be replaced with actual cloud logic
    throw new Error('Cloud provider integration not implemented in this local LLM integration');
  }

  /**
   * Stream response from local LLM for real-time UI updates
   */
  public async *streamLocalResponse(request: StellaRequest): AsyncGenerator<{ text: string; isComplete: boolean; metadata?: any }> {
    if (!this.llmService || !this.llmService.isReady()) {
      throw new Error('Local LLM service not ready');
    }

    try {
      // Create enhanced system prompt with context
      const systemPrompt = request.systemPrompt || this.createStellaSystemPrompt(request.context);

      // Ensure chat session with Stella system prompt
      await this.llmService.createChatSession(systemPrompt);

      // Configure for Stella use case
      const stellaConfig: Partial<LLMConfig> = {
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 2048,
      };

      // Stream response
      for await (const token of this.llmService.streamMessage(request.message, stellaConfig)) {
        yield {
          text: token.text,
          isComplete: token.isComplete,
          metadata: token.isComplete ? {
            tokensUsed: token.tokensUsed,
            inferenceTime: token.inferenceTime,
            memoryUsage: token.memoryUsage
          } : undefined
        };
      }

    } catch (error) {
      console.error('Local LLM streaming failed:', error);
      throw error;
    }
  }

  /**
   * Get current configuration and status
   */
  public getStatus() {
    return {
      defaultProvider: this.defaultProvider,
      localLLMEnabled: this.localLLMEnabled,
      localLLMReady: this.llmService ? this.llmService.isReady() : false,
      availableProviders: this.getAvailableProviders()
    };
  }

  /**
   * Enable or disable local LLM
   */
  public setLocalLLMEnabled(enabled: boolean): void {
    this.localLLMEnabled = enabled;
  }
}

// Global instance
let stellaLLMIntegration: StellaLLMIntegration | null = null;

/**
 * Setup Stella-LLM integration IPC handlers
 */
export const setupStellaLLMIntegration = (llmService?: LLMService) => {
  console.log('Setting up Stella-LLM integration...');

  stellaLLMIntegration = new StellaLLMIntegration(llmService);

  // Get available providers
  ipcMain.handle('stella-llm-get-providers', async (event: IpcMainInvokeEvent): Promise<StellaLLMProvider[]> => {
    return stellaLLMIntegration!.getAvailableProviders();
  });

  // Get status
  ipcMain.handle('stella-llm-get-status', async (event: IpcMainInvokeEvent) => {
    return stellaLLMIntegration!.getStatus();
  });

  // Set default provider
  ipcMain.handle('stella-llm-set-provider', async (event: IpcMainInvokeEvent, provider: 'local' | 'cloud' | 'auto'): Promise<void> => {
    stellaLLMIntegration!.setDefaultProvider(provider);
  });

  // Process Stella request
  ipcMain.handle('stella-llm-process-request', async (event: IpcMainInvokeEvent, request: StellaRequest): Promise<StellaResponse> => {
    return await stellaLLMIntegration!.processRequest(request);
  });

  // Stream Stella response
  ipcMain.handle('stella-llm-stream-request', async (event: IpcMainInvokeEvent, request: StellaRequest): Promise<string> => {
    const responseId = `stella-stream-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Start streaming in background
    (async () => {
      try {
        for await (const chunk of stellaLLMIntegration!.streamLocalResponse(request)) {
          event.sender.send('stella-llm-stream-chunk', {
            responseId,
            chunk
          });
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        event.sender.send('stella-llm-stream-error', {
          responseId,
          error: errorMessage
        });
      }
    })();

    return responseId;
  });

  // Enable/disable local LLM
  ipcMain.handle('stella-llm-set-enabled', async (event: IpcMainInvokeEvent, enabled: boolean): Promise<void> => {
    stellaLLMIntegration!.setLocalLLMEnabled(enabled);
  });

  console.log('✅ Stella-LLM integration setup completed');
};

/**
 * Update the LLM service reference in integration
 */
export const updateStellaLLMService = (llmService: LLMService): void => {
  if (stellaLLMIntegration) {
    stellaLLMIntegration.setLLMService(llmService);
  }
};