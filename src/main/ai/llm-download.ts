/**
 * LLM Model Download Service
 * Handles downloading, verification, and management of GGUF models
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import axios from 'axios';
import { app } from 'electron';
import { ModelConfig } from './llm-config';

export interface DownloadProgress {
  downloadId: string;
  status: 'starting' | 'downloading' | 'completed' | 'error' | 'cancelled';
  progress: number;
  bytesDownloaded: number;
  totalBytes: number;
  filename: string;
  speed: number; // bytes per second
  error?: string;
}

interface DownloadInfo extends DownloadProgress {
  url: string;
  filePath: string;
  tempPath: string;
  expectedChecksum?: string;
  startTime: number;
  abortController: AbortController;
}

/**
 * Service for downloading and managing LLM models
 */
export class LLMDownloadService extends EventEmitter {
  private modelsDir: string;
  private activeDownloads = new Map<string, DownloadInfo>();
  private downloadCounter = 0;

  constructor() {
    super();
    // Store models in userData/models directory
    this.modelsDir = path.join(app.getPath('userData'), 'models');
    this.ensureModelsDirectory();
  }

  /**
   * Ensure models directory exists
   */
  private async ensureModelsDirectory(): Promise<void> {
    try {
      await fs.ensureDir(this.modelsDir);
      console.log(`Models directory ensured: ${this.modelsDir}`);
    } catch (error) {
      console.error('Failed to create models directory:', error);
      throw error;
    }
  }

  /**
   * Get the full path to models directory
   */
  public getModelsDirectory(): string {
    return this.modelsDir;
  }

  /**
   * Start downloading a model
   */
  public async startDownload(model: ModelConfig): Promise<string> {
    const downloadId = `download-${++this.downloadCounter}`;
    const filePath = path.join(this.modelsDir, model.filename);
    const tempPath = `${filePath}.tmp`;

    // Check if file already exists
    if (await fs.pathExists(filePath)) {
      throw new Error(`Model already exists: ${model.filename}`);
    }

    const downloadInfo: DownloadInfo = {
      downloadId,
      url: model.url,
      filename: model.filename,
      filePath,
      tempPath,
      expectedChecksum: model.checksum,
      status: 'starting',
      progress: 0,
      bytesDownloaded: 0,
      totalBytes: model.size,
      speed: 0,
      startTime: Date.now(),
      abortController: new AbortController()
    };

    this.activeDownloads.set(downloadId, downloadInfo);

    // Start download in background
    this.performDownload(downloadInfo).catch(error => {
      downloadInfo.status = 'error';
      downloadInfo.error = error.message;
      console.error(`Download ${downloadId} failed:`, error);
      this.emit('error', { downloadId, error: error.message });
    });

    return downloadId;
  }

  /**
   * Perform the actual download with progress tracking and resume capability
   */
  private async performDownload(downloadInfo: DownloadInfo): Promise<void> {
    const { url, tempPath, filePath, abortController, expectedChecksum } = downloadInfo;

    try {
      downloadInfo.status = 'downloading';
      this.emit('progress', this.getProgressInfo(downloadInfo));

      // Check if we need to resume a partial download
      let resumePosition = 0;
      if (await fs.pathExists(tempPath)) {
        const stat = await fs.stat(tempPath);
        resumePosition = stat.size;
        downloadInfo.bytesDownloaded = resumePosition;
        console.log(`Resuming download from position: ${resumePosition}`);
      }

      // Set up headers for resume
      const headers: any = {};
      if (resumePosition > 0) {
        headers['Range'] = `bytes=${resumePosition}-`;
      }

      const response = await axios({
        method: 'GET',
        url,
        responseType: 'stream',
        headers,
        signal: abortController.signal,
        timeout: 30000, // 30 second timeout for initial response
      });

      // Get total file size
      const contentLength = response.headers['content-length'];
      const contentRange = response.headers['content-range'];
      
      if (contentRange) {
        // Parse range response: "bytes 1000-2000/3000"
        const match = contentRange.match(/bytes \d+-\d+\/(\d+)/);
        downloadInfo.totalBytes = match ? parseInt(match[1]) : downloadInfo.totalBytes;
      } else if (contentLength) {
        downloadInfo.totalBytes = parseInt(contentLength) + resumePosition;
      }

      // Create write stream (append mode if resuming)
      const writeStream = fs.createWriteStream(tempPath, { 
        flags: resumePosition > 0 ? 'a' : 'w' 
      });

      // Track download progress
      response.data.on('data', (chunk: Buffer) => {
        downloadInfo.bytesDownloaded += chunk.length;
        if (downloadInfo.totalBytes > 0) {
          downloadInfo.progress = Math.round(
            (downloadInfo.bytesDownloaded / downloadInfo.totalBytes) * 100
          );
        }

        downloadInfo.speed = this.calculateSpeed(downloadInfo);

        // Emit progress event periodically (throttled)
        if (downloadInfo.bytesDownloaded % (1024 * 1024) === 0 || downloadInfo.progress % 5 === 0) {
          this.emit('progress', this.getProgressInfo(downloadInfo));
        }
      });

      // Handle stream completion
      await new Promise<void>((resolve, reject) => {
        writeStream.on('error', reject);
        response.data.on('error', reject);

        writeStream.on('finish', async () => {
          try {
            // Verify checksum if provided
            if (expectedChecksum) {
              console.log(`Verifying checksum for ${downloadInfo.filename}...`);
              const actualChecksum = await this.calculateFileChecksum(tempPath);
              if (actualChecksum !== expectedChecksum) {
                throw new Error(`Checksum mismatch. Expected: ${expectedChecksum}, Got: ${actualChecksum}`);
              }
              console.log('Checksum verification passed');
            }

            // Move temp file to final location
            await fs.move(tempPath, filePath);
            
            downloadInfo.status = 'completed';
            downloadInfo.progress = 100;
            
            console.log(`Download completed: ${downloadInfo.filename}`);
            
            // Emit completion event
            this.emit('completed', {
              downloadId: downloadInfo.downloadId,
              filename: downloadInfo.filename,
              filePath: filePath,
              size: downloadInfo.bytesDownloaded
            });

            resolve();

          } catch (error: unknown) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            downloadInfo.status = 'error';
            downloadInfo.error = errorMessage;
            reject(error);
          }
        });

        // Pipe the response to file
        response.data.pipe(writeStream);
      });

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      downloadInfo.status = 'error';
      downloadInfo.error = errorMessage;
      
      // Clean up temp file on error
      try {
        if (await fs.pathExists(tempPath)) {
          await fs.remove(tempPath);
        }
      } catch (cleanupError) {
        console.error('Error cleaning up temp file:', cleanupError);
      }
      
      throw error;
    }
  }

  /**
   * Get download progress by ID
   */
  public getDownloadProgress(downloadId: string): DownloadProgress | null {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      return null;
    }

    return this.getProgressInfo(download);
  }

  /**
   * Cancel a download
   */
  public async cancelDownload(downloadId: string): Promise<boolean> {
    const download = this.activeDownloads.get(downloadId);
    if (!download) {
      throw new Error(`Download not found: ${downloadId}`);
    }

    if (download.status === 'completed') {
      throw new Error('Cannot cancel completed download');
    }

    // Abort the request
    download.abortController.abort();
    download.status = 'cancelled';

    // Clean up temp file
    try {
      if (await fs.pathExists(download.tempPath)) {
        await fs.remove(download.tempPath);
      }
    } catch (error) {
      console.error('Error cleaning up cancelled download:', error);
    }

    this.emit('cancelled', { downloadId });
    return true;
  }

  /**
   * Check if a model file exists
   */
  public async isModelDownloaded(filename: string): Promise<boolean> {
    const filePath = path.join(this.modelsDir, filename);
    return await fs.pathExists(filePath);
  }

  /**
   * Get path to a downloaded model
   */
  public getModelPath(filename: string): string {
    return path.join(this.modelsDir, filename);
  }

  /**
   * Delete a downloaded model
   */
  public async deleteModel(filename: string): Promise<boolean> {
    const filePath = path.join(this.modelsDir, filename);
    
    try {
      if (await fs.pathExists(filePath)) {
        await fs.remove(filePath);
        console.log(`Model deleted: ${filename}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error deleting model ${filename}:`, error);
      throw error;
    }
  }

  /**
   * List all downloaded models
   */
  public async getDownloadedModels(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.modelsDir);
      return files.filter(file => file.endsWith('.gguf'));
    } catch (error) {
      console.error('Error reading models directory:', error);
      return [];
    }
  }

  /**
   * Get total size of all downloaded models
   */
  public async getTotalModelsSize(): Promise<number> {
    try {
      const models = await this.getDownloadedModels();
      let totalSize = 0;
      
      for (const model of models) {
        const filePath = path.join(this.modelsDir, model);
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
      }
      
      return totalSize;
    } catch (error) {
      console.error('Error calculating models size:', error);
      return 0;
    }
  }

  /**
   * Get list of all active downloads
   */
  public getActiveDownloads(): DownloadProgress[] {
    return Array.from(this.activeDownloads.values()).map(download => 
      this.getProgressInfo(download)
    );
  }

  /**
   * Clean up completed or failed downloads from memory
   */
  public cleanupDownload(downloadId: string): boolean {
    const download = this.activeDownloads.get(downloadId);
    if (download && (download.status === 'completed' || download.status === 'error')) {
      this.activeDownloads.delete(downloadId);
      return true;
    }
    return false;
  }

  /**
   * Service cleanup - cancel all active downloads
   */
  public async cleanup(): Promise<void> {
    console.log('Cleaning up LLM download service...');
    
    for (const [downloadId, download] of Array.from(this.activeDownloads.entries())) {
      if (download.status === 'downloading') {
        try {
          await this.cancelDownload(downloadId);
        } catch (error) {
          console.error(`Error cancelling download ${downloadId}:`, error);
        }
      }
    }
    
    this.activeDownloads.clear();
  }

  /**
   * Calculate download speed in bytes per second
   */
  private calculateSpeed(downloadInfo: DownloadInfo): number {
    const elapsedTime = (Date.now() - downloadInfo.startTime) / 1000; // seconds
    return elapsedTime > 0 ? downloadInfo.bytesDownloaded / elapsedTime : 0;
  }

  /**
   * Calculate SHA256 checksum of a file
   */
  private async calculateFileChecksum(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (data: any) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Get formatted progress information
   */
  private getProgressInfo(download: DownloadInfo): DownloadProgress {
    return {
      downloadId: download.downloadId,
      status: download.status,
      progress: download.progress,
      bytesDownloaded: download.bytesDownloaded,
      totalBytes: download.totalBytes,
      filename: download.filename,
      speed: download.speed,
      error: download.error
    };
  }

  /**
   * Get download statistics
   */
  public getStats() {
    const downloads = Array.from(this.activeDownloads.values());
    return {
      total: downloads.length,
      active: downloads.filter(d => d.status === 'downloading').length,
      completed: downloads.filter(d => d.status === 'completed').length,
      failed: downloads.filter(d => d.status === 'error').length,
      cancelled: downloads.filter(d => d.status === 'cancelled').length
    };
  }
}