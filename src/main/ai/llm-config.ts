/**
 * LLM Configuration and Model Registry
 * Manages available models, configurations, and download URLs
 */

export interface ModelConfig {
  id: string;
  name: string;
  description: string;
  url: string;
  filename: string;
  size: number; // in bytes
  checksum?: string;
  quantization: string;
  contextSize: number;
  recommended: boolean;
}

export interface LLMConfig {
  // Model loading options
  contextSize: number;
  batchSize: number;
  threads: number;
  gpuLayers: number | 'auto';

  // Inference parameters
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;

  // Performance settings
  mlock: boolean;
  mmap: boolean;
  enableMetal: boolean; // Metal acceleration on macOS
}

/**
 * Registry of available GGUF models optimized for various use cases
 */
export const MODEL_REGISTRY: ModelConfig[] = [
  // NOTE: Qwen3.5 (hybrid SSM arch) and Gemma 4 do NOT load on the llama.cpp
  // binary bundled with node-llama-cpp 3.18.1 (b8390) — verified: Qwen3.5 fails
  // with "missing tensor blk.*.ssm_conv1d.weight". They need a newer runtime
  // (see tasks/local-provider-gemma4.md). Until then the recommended local model
  // is Qwen3 4B (dense, loads today, good 16GB fit).
  {
    id: 'qwen3-4b-q4',
    name: 'Qwen3 4B Q4_K_M',
    description:
      'Recommended local model — strong quality, ~2.5GB, fits 16GB alongside the embedding model. Best default for local Recall on current builds.',
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
    filename: 'Qwen3-4B-Q4_K_M.gguf',
    size: 2500000000, // 2.5GB
    quantization: 'Q4_K_M',
    contextSize: 32768,
    recommended: true,
  },
  {
    id: 'qwen3-0.6b-q8',
    name: 'Qwen3 0.6B Q8_0',
    description:
      'Ultra-lightweight Qwen3 model with thinking mode, perfect for low-resource devices',
    url: 'https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf',
    filename: 'Qwen3-0.6B-Q8_0.gguf',
    size: 639000000, // 639MB
    quantization: 'Q8_0',
    contextSize: 32768,
    recommended: false,
  },
  {
    id: 'qwen3-4b-q8',
    name: 'Qwen3 4B Q8_0',
    description:
      'High-quality Qwen3 4B model with Q8 quantization for better accuracy',
    url: 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q8_0.gguf',
    filename: 'Qwen3-4B-Q8_0.gguf',
    size: 4280000000, // 4.28GB
    quantization: 'Q8_0',
    contextSize: 32768,
    recommended: false,
  },
  {
    id: 'qwen3-8b-q4',
    name: 'Qwen3 8B Q4_K_M',
    description:
      'High-performance Qwen3 model with thinking mode and advanced capabilities',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    filename: 'Qwen3-8B-Q4_K_M.gguf',
    size: 5030000000, // 5.03GB
    quantization: 'Q4_K_M',
    contextSize: 32768,
    recommended: false,
  },
  {
    id: 'qwen3-8b-q8',
    name: 'Qwen3 8B Q8_0',
    description:
      'Premium Qwen3 8B model with Q8 quantization for highest quality',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q8_0.gguf',
    filename: 'Qwen3-8B-Q8_0.gguf',
    size: 8710000000, // 8.71GB
    quantization: 'Q8_0',
    contextSize: 32768,
    recommended: false,
  },
  {
    id: 'phi2-q4',
    name: 'Phi-2 Q4_K_M',
    description:
      "Microsoft's lightweight 2.7B model, great for chat and reasoning",
    url: 'https://huggingface.co/TheBloke/phi-2-GGUF/resolve/main/phi-2.Q4_K_M.gguf',
    filename: 'phi-2.Q4_K_M.gguf',
    size: 1790000000, // ~1.79GB
    quantization: 'Q4_K_M',
    contextSize: 2048,
    recommended: false,
  },
  {
    id: 'tinyllama-q4',
    name: 'TinyLlama 1.1B Q4_K_M',
    description:
      'Ultra-lightweight model for resource-constrained environments',
    url: 'https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf',
    filename: 'tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf',
    size: 669000000, // ~669MB
    quantization: 'Q4_K_M',
    contextSize: 2048,
    recommended: false,
  },
  {
    id: 'mistral7b-q4',
    name: 'Mistral 7B Instruct Q4_K_M',
    description: 'High-quality 7B model with excellent performance',
    url: 'https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf',
    filename: 'mistral-7b-instruct-v0.2.Q4_K_M.gguf',
    size: 4370000000, // ~4.37GB
    quantization: 'Q4_K_M',
    contextSize: 8192,
    recommended: false,
  },
  {
    id: 'llama2-7b-q4',
    name: 'Llama 2 7B Chat Q4_K_M',
    description: "Meta's popular 7B chat model",
    url: 'https://huggingface.co/TheBloke/Llama-2-7B-Chat-GGUF/resolve/main/llama-2-7b-chat.Q4_K_M.gguf',
    filename: 'llama-2-7b-chat.Q4_K_M.gguf',
    size: 4080000000, // ~4.08GB
    quantization: 'Q4_K_M',
    contextSize: 4096,
    recommended: false,
  },
  {
    id: 'codellama-7b-q4',
    name: 'CodeLlama 7B Q4_K_M',
    description: "Meta's code-focused model for programming tasks",
    url: 'https://huggingface.co/TheBloke/CodeLlama-7B-GGUF/resolve/main/codellama-7b.Q4_K_M.gguf',
    filename: 'codellama-7b.Q4_K_M.gguf',
    size: 4080000000, // ~4.08GB
    quantization: 'Q4_K_M',
    contextSize: 4096,
    recommended: false,
  },
];

/**
 * Default LLM configuration optimized for compatibility and performance
 */
export const DEFAULT_LLM_CONFIG: LLMConfig = {
  // Model loading - reduced defaults for better VRAM compatibility
  contextSize: 2048, // Reduced from 4096 to prevent VRAM issues
  batchSize: 256, // Reduced from 512 for lower memory usage
  threads: Math.max(1, Math.floor(require('os').cpus().length / 2)),
  gpuLayers: process.platform === 'darwin' ? 'auto' : 0, // Use Metal on macOS

  // Inference parameters
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  maxTokens: 2048,

  // Performance
  mlock: true,
  mmap: true,
  enableMetal: process.platform === 'darwin',
};

/**
 * Get recommended model based on available memory
 */
export function getRecommendedModel(): ModelConfig {
  const availableMemory = require('os').totalmem();
  const availableGB = availableMemory / (1024 * 1024 * 1024);

  // If less than 4GB RAM, use smallest model (0.6B)
  if (availableGB < 4) {
    return (
      MODEL_REGISTRY.find((m) => m.id === 'qwen3-0.6b-q8') || MODEL_REGISTRY[0]
    );
  }

  // If less than 8GB RAM, use 0.6B model (very lightweight)
  if (availableGB < 8) {
    return (
      MODEL_REGISTRY.find((m) => m.id === 'qwen3-0.6b-q8') || MODEL_REGISTRY[0]
    );
  }

  // Default to recommended 0.6B model (fastest and most compatible)
  return MODEL_REGISTRY.find((m) => m.recommended) || MODEL_REGISTRY[0];
}

/**
 * Get model configuration by ID
 */
export function getModelById(id: string): ModelConfig | undefined {
  return MODEL_REGISTRY.find((model) => model.id === id);
}

/**
 * Validate LLM configuration
 */
export function validateConfig(config: Partial<LLMConfig>): LLMConfig {
  return {
    ...DEFAULT_LLM_CONFIG,
    ...config,
    // Ensure sensible bounds
    temperature: Math.max(
      0.1,
      Math.min(2.0, config.temperature || DEFAULT_LLM_CONFIG.temperature),
    ),
    topP: Math.max(0.1, Math.min(1.0, config.topP || DEFAULT_LLM_CONFIG.topP)),
    topK: Math.max(1, Math.min(100, config.topK || DEFAULT_LLM_CONFIG.topK)),
    maxTokens: Math.max(
      1,
      Math.min(8192, config.maxTokens || DEFAULT_LLM_CONFIG.maxTokens),
    ),
    contextSize: Math.max(
      512,
      Math.min(32768, config.contextSize || DEFAULT_LLM_CONFIG.contextSize),
    ),
  };
}

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
