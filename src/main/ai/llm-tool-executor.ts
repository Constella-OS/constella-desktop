/**
 * Tool Execution Engine for Local LLM
 * Handles execution of tool calls by interfacing with the main process
 */

import { ipcMain } from 'electron';
import { ToolCall, ToolResult, ToolManager, ToolExecutionContext } from './llm-tools';

export class ToolExecutor {
  private toolManager: ToolManager;
  private executionContext: ToolExecutionContext = {};

  constructor(toolManager: ToolManager) {
    this.toolManager = toolManager;
    this.setupIpcHandlers();
  }

  /**
   * Set up IPC handlers for tool execution
   */
  private setupIpcHandlers(): void {
    // These handlers will be called from the renderer process
    // The actual implementation will be provided by the main process
    
    ipcMain.handle('tool-executor:set-context', (_event, context: ToolExecutionContext) => {
      this.setExecutionContext(context);
      return { success: true };
    });

    ipcMain.handle('tool-executor:execute-tool', async (_event, toolCall: ToolCall) => {
      return await this.executeTool(toolCall);
    });

    ipcMain.handle('tool-executor:execute-tools', async (_event, toolCalls: ToolCall[]) => {
      return await this.executeTools(toolCalls);
    });
  }

  /**
   * Set the execution context (functions to call for each tool)
   */
  public setExecutionContext(context: ToolExecutionContext): void {
    this.executionContext = { ...this.executionContext, ...context };
  }

  /**
   * Execute a single tool call
   */
  public async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    try {
      // Validate the tool call
      const validation = this.toolManager.validateToolCall(toolCall);
      if (!validation.valid) {
        return {
          tool_call: toolCall.tool_call,
          call_id: toolCall.call_id,
          result: null,
          success: false,
          error: validation.error
        };
      }

      // Execute based on tool type
      let result: any;
      const args = toolCall.arguments;

      switch (toolCall.tool_call) {
        case 'create_note':
          if (!this.executionContext.createNote) {
            throw new Error('create_note function not available in execution context');
          }
          result = await this.executionContext.createNote({
            title: args.title,
            content: args.content,
            tags: args.tags || []
          });
          break;

        case 'edit_note':
          if (!this.executionContext.editNote) {
            throw new Error('edit_note function not available in execution context');
          }
          result = await this.executionContext.editNote({
            note_uniqueid: args.note_uniqueid,
            title: args.title,
            content: args.content,
            tags: args.tags
          });
          break;

        case 'delete_note':
          if (!this.executionContext.deleteNote) {
            throw new Error('delete_note function not available in execution context');
          }
          result = await this.executionContext.deleteNote(args.note_uniqueid);
          break;

        case 'create_connection':
          if (!this.executionContext.createConnection) {
            throw new Error('create_connection function not available in execution context');
          }
          result = await this.executionContext.createConnection(
            args.start_note_uniqueid,
            args.end_note_uniqueid
          );
          break;

        case 'delete_connection':
          if (!this.executionContext.deleteConnection) {
            throw new Error('delete_connection function not available in execution context');
          }
          result = await this.executionContext.deleteConnection(
            args.start_note_uniqueid,
            args.end_note_uniqueid
          );
          break;

        case 'converse_with_user':
          if (!this.executionContext.sendMessageToUser) {
            throw new Error('sendMessageToUser function not available in execution context');
          }
          result = await this.executionContext.sendMessageToUser(args.long_message);
          break;

        case 'edit_note_title':
          if (!this.executionContext.editNoteTitle) {
            throw new Error('edit_note_title function not available in execution context');
          }
          result = await this.executionContext.editNoteTitle(
            args.note_uniqueid,
            args.new_title
          );
          break;

        case 'add_tags_to_note':
          if (!this.executionContext.addTagsToNote) {
            throw new Error('add_tags_to_note function not available in execution context');
          }
          result = await this.executionContext.addTagsToNote(
            args.note_uniqueid,
            args.tags_to_add || []
          );
          break;

        case 'remove_tags_from_note':
          if (!this.executionContext.removeTagsFromNote) {
            throw new Error('remove_tags_from_note function not available in execution context');
          }
          result = await this.executionContext.removeTagsFromNote(
            args.note_uniqueid,
            args.tags_to_remove || []
          );
          break;

        case 'delete_part_of_note_content':
          if (!this.executionContext.deletePartOfNoteContent) {
            throw new Error('delete_part_of_note_content function not available in execution context');
          }
          result = await this.executionContext.deletePartOfNoteContent(
            args.note_uniqueid,
            args.content_part_to_delete
          );
          break;

        case 'replace_part_of_note_content':
          if (!this.executionContext.replacePartOfNoteContent) {
            throw new Error('replace_part_of_note_content function not available in execution context');
          }
          result = await this.executionContext.replacePartOfNoteContent(
            args.note_uniqueid,
            args.content_part_to_replace,
            args.replacement_content
          );
          break;

        case 'add_part_to_note_content':
          if (!this.executionContext.addPartToNoteContent) {
            throw new Error('add_part_to_note_content function not available in execution context');
          }
          result = await this.executionContext.addPartToNoteContent(
            args.note_uniqueid,
            args.content_to_add
          );
          break;

        default:
          throw new Error(`Unknown tool: ${toolCall.tool_call}`);
      }

      return {
        tool_call: toolCall.tool_call,
        call_id: toolCall.call_id,
        result,
        success: true
      };

    } catch (error: any) {
      console.error(`Tool execution failed for ${toolCall.tool_call}:`, error);
      return {
        tool_call: toolCall.tool_call,
        call_id: toolCall.call_id,
        result: null,
        success: false,
        error: error.message || 'Unknown error occurred'
      };
    }
  }

  /**
   * Execute multiple tool calls sequentially
   */
  public async executeTools(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    
    for (const toolCall of toolCalls) {
      const result = await this.executeTool(toolCall);
      results.push(result);
      
      // If a tool fails, optionally decide whether to continue or stop
      if (!result.success) {
        console.warn(`Tool ${toolCall.tool_call} failed, continuing with remaining tools...`);
      }
    }
    
    return results;
  }

  /**
   * Get execution statistics
   */
  public getExecutionStats() {
    return {
      availableTools: this.toolManager.getTools().length,
      contextFunctions: Object.keys(this.executionContext).length,
      isReady: this.isReady()
    };
  }

  /**
   * Check if executor is ready to execute tools
   */
  public isReady(): boolean {
    // Check if we have at least some basic functions available
    return !!(this.executionContext.createNote || 
              this.executionContext.editNote || 
              this.executionContext.sendMessageToUser);
  }

  /**
   * Cleanup resources
   */
  public cleanup(): void {
    // Remove IPC handlers
    ipcMain.removeHandler('tool-executor:set-context');
    ipcMain.removeHandler('tool-executor:execute-tool');
    ipcMain.removeHandler('tool-executor:execute-tools');
    
    // Clear execution context
    this.executionContext = {};
  }
}

/**
 * Create a default tool executor instance
 */
export function createToolExecutor(): ToolExecutor {
  const toolManager = new ToolManager();
  return new ToolExecutor(toolManager);
}