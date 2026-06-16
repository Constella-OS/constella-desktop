/**
 * LLM Settings Management
 * Handles persistent storage and management of LLM-related settings
 */

import { getStoreValue, setStoreValue } from '../utils/storage/store';
import { LLMConfig, DEFAULT_LLM_CONFIG, validateConfig, ModelConfig } from './llm-config';

// Store keys for LLM settings
export const LLM_STORE_KEYS = {
  // General LLM settings
  ENABLED: 'llm.enabled',
  DEFAULT_PROVIDER: 'llm.defaultProvider',
  PREFERRED_MODEL: 'llm.preferredModel',
  
  // Model configuration
  CONFIG: 'llm.config',
  
  // Stella integration settings
  STELLA_PROVIDER: 'llm.stella.provider',
  STELLA_ENABLED: 'llm.stella.enabled',
  
  // Download preferences
  AUTO_DOWNLOAD_RECOMMENDED: 'llm.download.autoRecommended',
  MODELS_STORAGE_LIMIT: 'llm.download.storageLimit',
  
  // Privacy and performance
  USAGE_ANALYTICS: 'llm.privacy.analytics',
  METAL_ACCELERATION: 'llm.performance.metal',
  
  // UI preferences
  SHOW_DOWNLOAD_PROGRESS: 'llm.ui.showDownloadProgress',
  SHOW_MEMORY_USAGE: 'llm.ui.showMemoryUsage',
};

export interface LLMSettings {
  // General settings
  enabled: boolean;
  defaultProvider: 'local' | 'cloud' | 'auto';
  preferredModel: string | null;
  
  // Model configuration
  config: LLMConfig;
  
  // Stella integration
  stellaProvider: 'local' | 'cloud' | 'auto';
  stellaEnabled: boolean;
  
  // Download preferences
  autoDownloadRecommended: boolean;
  modelsStorageLimit: number; // in GB, 0 = unlimited
  
  // Privacy and performance
  usageAnalytics: boolean;
  metalAcceleration: boolean;
  
  // UI preferences
  showDownloadProgress: boolean;
  showMemoryUsage: boolean;
}

/**
 * Default LLM settings
 */
export const DEFAULT_LLM_SETTINGS: LLMSettings = {
  enabled: true,
  defaultProvider: 'auto',
  preferredModel: null, // Will be set to recommended model on first run
  
  config: DEFAULT_LLM_CONFIG,
  
  stellaProvider: 'auto',
  stellaEnabled: true,
  
  autoDownloadRecommended: true,
  modelsStorageLimit: 10, // 10GB default limit
  
  usageAnalytics: false, // Privacy-first default
  metalAcceleration: process.platform === 'darwin',
  
  showDownloadProgress: true,
  showMemoryUsage: false,
};

/**
 * LLM Settings Manager
 */
export class LLMSettingsManager {
  private settings: LLMSettings;
  private initialized = false;

  constructor() {
    this.settings = { ...DEFAULT_LLM_SETTINGS };
  }

  /**
   * Initialize settings by loading from storage
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load all settings from storage with proper type casting
      const getTypedValue = async <T>(key: string, defaultValue: T): Promise<T> => {
        const value = await getStoreValue(key, defaultValue as any);
        return value as T;
      };

      this.settings = {
        enabled: await getTypedValue(LLM_STORE_KEYS.ENABLED, DEFAULT_LLM_SETTINGS.enabled),
        defaultProvider: await getTypedValue(LLM_STORE_KEYS.DEFAULT_PROVIDER, DEFAULT_LLM_SETTINGS.defaultProvider),
        preferredModel: await getTypedValue(LLM_STORE_KEYS.PREFERRED_MODEL, DEFAULT_LLM_SETTINGS.preferredModel),
        
        config: validateConfig(await getTypedValue(LLM_STORE_KEYS.CONFIG, DEFAULT_LLM_SETTINGS.config)),
        
        stellaProvider: await getTypedValue(LLM_STORE_KEYS.STELLA_PROVIDER, DEFAULT_LLM_SETTINGS.stellaProvider),
        stellaEnabled: await getTypedValue(LLM_STORE_KEYS.STELLA_ENABLED, DEFAULT_LLM_SETTINGS.stellaEnabled),
        
        autoDownloadRecommended: await getTypedValue(LLM_STORE_KEYS.AUTO_DOWNLOAD_RECOMMENDED, DEFAULT_LLM_SETTINGS.autoDownloadRecommended),
        modelsStorageLimit: await getTypedValue(LLM_STORE_KEYS.MODELS_STORAGE_LIMIT, DEFAULT_LLM_SETTINGS.modelsStorageLimit),
        
        usageAnalytics: await getTypedValue(LLM_STORE_KEYS.USAGE_ANALYTICS, DEFAULT_LLM_SETTINGS.usageAnalytics),
        metalAcceleration: await getTypedValue(LLM_STORE_KEYS.METAL_ACCELERATION, DEFAULT_LLM_SETTINGS.metalAcceleration),
        
        showDownloadProgress: await getTypedValue(LLM_STORE_KEYS.SHOW_DOWNLOAD_PROGRESS, DEFAULT_LLM_SETTINGS.showDownloadProgress),
        showMemoryUsage: await getTypedValue(LLM_STORE_KEYS.SHOW_MEMORY_USAGE, DEFAULT_LLM_SETTINGS.showMemoryUsage),
      };

      this.initialized = true;
      console.log('LLM settings initialized successfully');
    } catch (error) {
      console.error('Failed to initialize LLM settings:', error);
      // Fallback to defaults
      this.settings = { ...DEFAULT_LLM_SETTINGS };
      this.initialized = true;
    }
  }

  /**
   * Get all settings
   */
  public getSettings(): LLMSettings {
    if (!this.initialized) {
      throw new Error('Settings not initialized. Call initialize() first.');
    }
    return { ...this.settings };
  }

  /**
   * Get specific setting
   */
  public getSetting<K extends keyof LLMSettings>(key: K): LLMSettings[K] {
    if (!this.initialized) {
      throw new Error('Settings not initialized. Call initialize() first.');
    }
    return this.settings[key];
  }

  /**
   * Update settings (partial update)
   */
  public async updateSettings(updates: Partial<LLMSettings>): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Update in-memory settings
      this.settings = { ...this.settings, ...updates };

      // Validate config if it was updated
      if (updates.config) {
        this.settings.config = validateConfig(updates.config);
      }

      // Persist to storage
      await this.persistSettings();

      console.log('LLM settings updated successfully');
    } catch (error) {
      console.error('Failed to update LLM settings:', error);
      throw error;
    }
  }

  /**
   * Update specific setting
   */
  public async updateSetting<K extends keyof LLMSettings>(key: K, value: LLMSettings[K]): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    try {
      // Update in-memory settings
      (this.settings as any)[key] = value;

      // Validate config if it was updated
      if (key === 'config') {
        this.settings.config = validateConfig(value as LLMConfig);
      }

      // Persist to storage
      await this.persistSettings();

      console.log(`LLM setting '${key}' updated successfully`);
    } catch (error) {
      console.error(`Failed to update LLM setting '${key}':`, error);
      throw error;
    }
  }

  /**
   * Reset settings to defaults
   */
  public async resetSettings(): Promise<void> {
    try {
      this.settings = { ...DEFAULT_LLM_SETTINGS };
      await this.persistSettings();
      console.log('LLM settings reset to defaults');
    } catch (error) {
      console.error('Failed to reset LLM settings:', error);
      throw error;
    }
  }

  /**
   * Reset specific setting to default
   */
  public async resetSetting<K extends keyof LLMSettings>(key: K): Promise<void> {
    await this.updateSetting(key, DEFAULT_LLM_SETTINGS[key]);
  }

  /**
   * Get LLM configuration for service
   */
  public getLLMConfig(): LLMConfig {
    if (!this.initialized) {
      return DEFAULT_LLM_CONFIG;
    }
    return { ...this.settings.config };
  }

  /**
   * Update LLM configuration
   */
  public async updateLLMConfig(config: Partial<LLMConfig>): Promise<void> {
    const newConfig = validateConfig({ ...this.settings.config, ...config });
    await this.updateSetting('config', newConfig);
  }

  /**
   * Check if local LLM is enabled
   */
  public isLocalLLMEnabled(): boolean {
    return this.settings.enabled;
  }

  /**
   * Check if Stella integration is enabled
   */
  public isStellaEnabled(): boolean {
    return this.settings.stellaEnabled;
  }

  /**
   * Get preferred model ID
   */
  public getPreferredModel(): string | null {
    return this.settings.preferredModel;
  }

  /**
   * Set preferred model
   */
  public async setPreferredModel(modelId: string | null): Promise<void> {
    await this.updateSetting('preferredModel', modelId);
  }

  /**
   * Get Stella provider preference
   */
  public getStellaProvider(): 'local' | 'cloud' | 'auto' {
    return this.settings.stellaProvider;
  }

  /**
   * Check if Metal acceleration is enabled
   */
  public isMetalAccelerationEnabled(): boolean {
    return this.settings.metalAcceleration && process.platform === 'darwin';
  }

  /**
   * Get storage limit for models (in bytes, 0 = unlimited)
   */
  public getStorageLimit(): number {
    return this.settings.modelsStorageLimit * 1024 * 1024 * 1024; // Convert GB to bytes
  }

  /**
   * Check if auto-download of recommended model is enabled
   */
  public isAutoDownloadEnabled(): boolean {
    return this.settings.autoDownloadRecommended;
  }

  /**
   * Export settings for backup
   */
  public exportSettings(): string {
    if (!this.initialized) {
      throw new Error('Settings not initialized');
    }
    return JSON.stringify(this.settings, null, 2);
  }

  /**
   * Import settings from backup
   */
  public async importSettings(settingsJson: string): Promise<void> {
    try {
      const importedSettings = JSON.parse(settingsJson) as Partial<LLMSettings>;
      
      // Validate imported settings
      const validatedSettings: Partial<LLMSettings> = {};
      
      // Only import valid keys
      for (const key in DEFAULT_LLM_SETTINGS) {
        if (key in importedSettings) {
          (validatedSettings as any)[key] = (importedSettings as any)[key];
        }
      }

      await this.updateSettings(validatedSettings);
      console.log('LLM settings imported successfully');
    } catch (error) {
      console.error('Failed to import LLM settings:', error);
      throw new Error('Invalid settings format');
    }
  }

  /**
   * Persist current settings to storage
   */
  private async persistSettings(): Promise<void> {
    await Promise.all([
      setStoreValue(LLM_STORE_KEYS.ENABLED, this.settings.enabled),
      setStoreValue(LLM_STORE_KEYS.DEFAULT_PROVIDER, this.settings.defaultProvider),
      setStoreValue(LLM_STORE_KEYS.PREFERRED_MODEL, this.settings.preferredModel),
      
      setStoreValue(LLM_STORE_KEYS.CONFIG, this.settings.config),
      
      setStoreValue(LLM_STORE_KEYS.STELLA_PROVIDER, this.settings.stellaProvider),
      setStoreValue(LLM_STORE_KEYS.STELLA_ENABLED, this.settings.stellaEnabled),
      
      setStoreValue(LLM_STORE_KEYS.AUTO_DOWNLOAD_RECOMMENDED, this.settings.autoDownloadRecommended),
      setStoreValue(LLM_STORE_KEYS.MODELS_STORAGE_LIMIT, this.settings.modelsStorageLimit),
      
      setStoreValue(LLM_STORE_KEYS.USAGE_ANALYTICS, this.settings.usageAnalytics),
      setStoreValue(LLM_STORE_KEYS.METAL_ACCELERATION, this.settings.metalAcceleration),
      
      setStoreValue(LLM_STORE_KEYS.SHOW_DOWNLOAD_PROGRESS, this.settings.showDownloadProgress),
      setStoreValue(LLM_STORE_KEYS.SHOW_MEMORY_USAGE, this.settings.showMemoryUsage),
    ]);
  }

  /**
   * Get settings summary for debugging
   */
  public getSettingsSummary(): Record<string, any> {
    if (!this.initialized) {
      return { initialized: false };
    }

    return {
      initialized: true,
      enabled: this.settings.enabled,
      provider: this.settings.defaultProvider,
      model: this.settings.preferredModel,
      stellaEnabled: this.settings.stellaEnabled,
      stellaProvider: this.settings.stellaProvider,
      metalAcceleration: this.settings.metalAcceleration,
      contextSize: this.settings.config.contextSize,
      temperature: this.settings.config.temperature,
    };
  }
}

// Singleton instance
let settingsManager: LLMSettingsManager | null = null;

/**
 * Get the global settings manager instance
 */
export const getLLMSettingsManager = (): LLMSettingsManager => {
  if (!settingsManager) {
    settingsManager = new LLMSettingsManager();
  }
  return settingsManager;
};