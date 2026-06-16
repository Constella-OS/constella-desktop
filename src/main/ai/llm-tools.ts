/**
 * Tool Calling System for Local LLM
 * Provides function calling capabilities for the local LLM service
 */

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required?: boolean;
  enum?: string[];
  properties?: Record<string, ToolParameter>;
  items?: ToolParameter;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolCall {
  tool_call: string;
  arguments: Record<string, any>;
  call_id?: string;
}

export interface ToolResult {
  tool_call: string;
  call_id?: string;
  result: any;
  success: boolean;
  error?: string;
}

/**
 * Available tools for the local LLM
 */
export const AVAILABLE_TOOLS: ToolDefinition[] = [
  {
    name: 'create_note',
    description: 'Create a new note with title, content, and tags',
    parameters: {
      title: {
        type: 'string',
        description: 'The title of the note',
        required: true,
      },
      content: {
        type: 'string',
        description: 'The content/body of the note',
        required: true,
      },
      tags: {
        type: 'array',
        description: 'Array of tag names to apply to the note',
        items: { type: 'string', description: 'Tag name' },
      },
    },
    required: ['title', 'content'],
  },
  {
    name: 'edit_note',
    description: 'Edit an existing note by its unique ID',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note to edit',
        required: true,
      },
      title: {
        type: 'string',
        description: 'New title for the note',
      },
      content: {
        type: 'string',
        description: 'New content for the note',
      },
      tags: {
        type: 'array',
        description: 'New tags array for the note',
        items: { type: 'string', description: 'Tag name' },
      },
    },
    required: ['note_uniqueid'],
  },
  {
    name: 'delete_note',
    description: 'Delete a note by its unique ID',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note to delete',
        required: true,
      },
    },
    required: ['note_uniqueid'],
  },
  {
    name: 'create_connection',
    description: 'Create a connection between two notes',
    parameters: {
      start_note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the starting note',
        required: true,
      },
      end_note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the ending note',
        required: true,
      },
    },
    required: ['start_note_uniqueid', 'end_note_uniqueid'],
  },
  {
    name: 'delete_connection',
    description: 'Delete a connection between two notes',
    parameters: {
      start_note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the starting note',
        required: true,
      },
      end_note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the ending note',
        required: true,
      },
    },
    required: ['start_note_uniqueid', 'end_note_uniqueid'],
  },
  {
    name: 'converse_with_user',
    description: 'Send a conversational message to the user',
    parameters: {
      long_message: {
        type: 'string',
        description: 'The message to send to the user',
        required: true,
      },
    },
    required: ['long_message'],
  },
  {
    name: 'edit_note_title',
    description: 'Edit only the title of an existing note',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note to edit',
        required: true,
      },
      new_title: {
        type: 'string',
        description: 'The new title for the note',
        required: true,
      },
    },
    required: ['note_uniqueid', 'new_title'],
  },
  {
    name: 'add_tags_to_note',
    description: 'Add tags to an existing note',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note',
        required: true,
      },
      tags_to_add: {
        type: 'array',
        description: 'Array of tag names to add to the note',
        items: { type: 'string', description: 'Tag name' },
      },
    },
    required: ['note_uniqueid', 'tags_to_add'],
  },
  {
    name: 'remove_tags_from_note',
    description: 'Remove tags from an existing note',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note',
        required: true,
      },
      tags_to_remove: {
        type: 'array',
        description: 'Array of tag names to remove from the note',
        items: { type: 'string', description: 'Tag name' },
      },
    },
    required: ['note_uniqueid', 'tags_to_remove'],
  },
  {
    name: 'delete_part_of_note_content',
    description: 'Delete a specific part of note content',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note',
        required: true,
      },
      content_part_to_delete: {
        type: 'string',
        description: 'The exact text content to delete from the note',
        required: true,
      },
    },
    required: ['note_uniqueid', 'content_part_to_delete'],
  },
  {
    name: 'replace_part_of_note_content',
    description: 'Replace a specific part of note content with new content',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note',
        required: true,
      },
      content_part_to_replace: {
        type: 'string',
        description: 'The exact text content to replace',
        required: true,
      },
      replacement_content: {
        type: 'string',
        description: 'The new content to replace with',
        required: true,
      },
    },
    required: [
      'note_uniqueid',
      'content_part_to_replace',
      'replacement_content',
    ],
  },
  {
    name: 'add_part_to_note_content',
    description: 'Add content to the end of an existing note',
    parameters: {
      note_uniqueid: {
        type: 'string',
        description: 'The unique ID of the note',
        required: true,
      },
      content_to_add: {
        type: 'string',
        description: 'The content to add to the note',
        required: true,
      },
    },
    required: ['note_uniqueid', 'content_to_add'],
  },
];

/**
 * Tool Manager Class
 */
export class ToolManager {
  private tools: Map<string, ToolDefinition> = new Map();

  constructor() {
    // Register default tools
    AVAILABLE_TOOLS.forEach((tool) => {
      this.tools.set(tool.name, tool);
    });
  }

  /**
   * Get all available tools
   */
  public getTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Get a specific tool by name
   */
  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * Register a new tool
   */
  public registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Unregister a tool
   */
  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Generate OpenAI Function Calling format for tools
   */
  public generateFunctionCallFormat(): string {
    const functions = this.getTools().map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: tool.parameters,
          required: tool.required || [],
        },
      },
    }));

    return JSON.stringify(functions, null, 2);
  }

  /**
   * Generate system prompt for tool calling
   */
  public generateToolCallingSystemPrompt(): string {
    const toolsList = this.getTools()
      .map((tool) => {
        const params = Object.entries(tool.parameters)
          .map(([name, param]) => {
            const required = tool.required?.includes(name)
              ? ' (required)'
              : ' (optional)';
            return `  - ${name}${required}: ${param.description}`;
          })
          .join('\n');

        return `${tool.name}: ${tool.description}\nParameters:\n${params}`;
      })
      .join('\n\n');

    return `You are an AI assistant integrated into Constella, a note-taking application. You can interact with the application using function calls.

Available Functions:
${toolsList}

When you need to perform actions, respond with a JSON object in this exact format:
{
  "tool_call": "function_name",
  "arguments": {
    "parameter1": "value1",
    "parameter2": "value2"
  }
}

For conversational responses that don't require actions, use the converse_with_user function with your message.

Always ensure your function calls use the correct parameter names and types as defined above.`;
  }

  /**
   * Validate a tool call
   */
  public validateToolCall(toolCall: ToolCall): {
    valid: boolean;
    error?: string;
  } {
    const tool = this.getTool(toolCall.tool_call);

    if (!tool) {
      return { valid: false, error: `Unknown tool: ${toolCall.tool_call}` };
    }

    // Check required parameters
    if (tool.required) {
      for (const required of tool.required) {
        if (!(required in toolCall.arguments)) {
          return {
            valid: false,
            error: `Missing required parameter: ${required}`,
          };
        }
      }
    }

    // Check parameter types
    for (const [paramName, paramValue] of Object.entries(toolCall.arguments)) {
      const paramDef = tool.parameters[paramName];
      if (!paramDef) {
        return { valid: false, error: `Unknown parameter: ${paramName}` };
      }

      // Basic type checking
      const expectedType = paramDef.type;
      const actualType = Array.isArray(paramValue)
        ? 'array'
        : typeof paramValue;

      if (
        expectedType !== actualType &&
        paramValue !== null &&
        paramValue !== undefined
      ) {
        return {
          valid: false,
          error: `Parameter ${paramName} should be ${expectedType}, got ${actualType}`,
        };
      }
    }

    return { valid: true };
  }
}

/**
 * Parse tool calls from LLM response text
 */
export function parseToolCallsFromResponse(response: string): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  // Look for JSON objects in the response
  const jsonRegex = /\{[^{}]*"tool_call"[^{}]*\}/g;
  const matches = response.match(jsonRegex);

  if (matches) {
    for (const match of matches) {
      try {
        const parsed = JSON.parse(match);
        if (parsed.tool_call && parsed.arguments) {
          toolCalls.push({
            tool_call: parsed.tool_call,
            arguments: parsed.arguments,
            call_id:
              parsed.call_id ||
              `call_${Date.now()}_${Math.random()
                .toString(36)
                .substring(2, 11)}`,
          });
        }
      } catch (error) {
        console.warn('Failed to parse potential tool call:', match, error);
      }
    }
  }

  return toolCalls;
}

/**
 * Extract conversational text from response (text that's not tool calls)
 */
export function extractConversationalText(response: string): string {
  // Remove JSON tool calls from the response
  const cleanedResponse = response
    .replace(/\{[^{}]*"tool_call"[^{}]*\}/g, '')
    .trim();
  return cleanedResponse;
}

/**
 * Tool Execution Context interface (exported for use in other modules)
 */
export interface ToolExecutionContext {
  // Note functions
  createNote?: (data: {
    title: string;
    content: string;
    tags?: string[];
  }) => Promise<any>;
  editNote?: (data: {
    note_uniqueid: string;
    title?: string;
    content?: string;
    tags?: string[];
  }) => Promise<any>;
  deleteNote?: (noteId: string) => Promise<any>;
  editNoteTitle?: (noteId: string, newTitle: string) => Promise<any>;
  addTagsToNote?: (noteId: string, tags: string[]) => Promise<any>;
  removeTagsFromNote?: (noteId: string, tags: string[]) => Promise<any>;
  deletePartOfNoteContent?: (
    noteId: string,
    contentToDelete: string,
  ) => Promise<any>;
  replacePartOfNoteContent?: (
    noteId: string,
    oldContent: string,
    newContent: string,
  ) => Promise<any>;
  addPartToNoteContent?: (noteId: string, contentToAdd: string) => Promise<any>;

  // Connection functions
  createConnection?: (startNoteId: string, endNoteId: string) => Promise<any>;
  deleteConnection?: (startNoteId: string, endNoteId: string) => Promise<any>;

  // User interaction
  sendMessageToUser?: (message: string) => Promise<any>;
}
