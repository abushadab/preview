const AWS = require('aws-sdk');
const { createWriteStream, createReadStream } = require('fs');
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);
const tar = require('tar');
const path = require('path');
const fs = require('fs').promises;
const logger = require('../utils/logger');

class StorageService {
  constructor() {
    this.s3 = null;
    this.bucket = process.env.S3_BUCKET || 'sandbox';
    this.MAX_EXTRACT_SIZE = 100 * 1024 * 1024; // 100MB extracted limit
    this.MAX_ARCHIVE_SIZE = 50 * 1024 * 1024; // 50MB archive limit
    this.MAX_COMPRESSION_RATIO = 50; // Prevent decompression bombs - max 50x compression ratio
  }

  async initialize() {
    try {
      this.s3 = new AWS.S3({
        endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
        accessKeyId: process.env.MINIO_ROOT_USER || 'admin',
        secretAccessKey: process.env.MINIO_ROOT_PASSWORD || 'supersecret',
        region: process.env.S3_REGION || 'us-east-1',
        s3ForcePathStyle: true
      });

      // Create bucket if it doesn't exist
      try {
        await this.s3.headBucket({ Bucket: this.bucket }).promise();
        logger.info(`Bucket ${this.bucket} exists`);
      } catch (error) {
        if (error.code === 'NotFound') {
          await this.s3.createBucket({ Bucket: this.bucket }).promise();
          logger.info(`Bucket ${this.bucket} created`);
        } else {
          throw error;
        }
      }

      logger.info('StorageService initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize StorageService:', error);
      throw error;
    }
  }

  async storeSnapshot(sandboxId, files) {
    try {
      const tempDir = `/var/lib/preview/projects/${sandboxId}`;
      await fs.mkdir(tempDir, { recursive: true });

      // Write files to temp directory
      for (const file of files) {
        const filePath = path.join(tempDir, file.path);

        // Validate file path to prevent traversal attacks
        if (path.isAbsolute(file.path) || file.path.split(path.sep).includes('..')) {
          throw new Error(`Invalid file path: ${file.path}`);
        }

        const dirPath = path.dirname(filePath);
        await fs.mkdir(dirPath, { recursive: true });

        const content = Buffer.from(file.content, 'base64');
        await fs.writeFile(filePath, content);
      }

      // Create tar archive
      const tarPath = `/tmp/snapshot-${sandboxId}.tar`;
      await tar.create({
        cwd: tempDir,
        file: tarPath
      }, ['.']);

      // Upload to S3
      const fileStream = createReadStream(tarPath);
      await this.s3.upload({
        Bucket: this.bucket,
        Key: `sandbox/${sandboxId}/snapshot.tar`,
        Body: fileStream,
        ContentType: 'application/x-tar'
      }).promise();

      logger.info(`Uploaded snapshot to S3 for sandbox ${sandboxId}`);

      logger.info(`Snapshot stored for sandbox ${sandboxId}`);

      // Cleanup temp files
      await fs.rm(tempDir, { recursive: true, force: true });
      await fs.unlink(tarPath);

      return true;
    } catch (error) {
      logger.error(`Failed to store snapshot for sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  async getSnapshot(sandboxId) {
    try {
      const getObjectParams = {
        Bucket: this.bucket,
        Key: `sandbox/${sandboxId}/snapshot.tar`
      };

      const response = await this.s3.getObject(getObjectParams).promise();

      // Check compressed archive size
      if (response.ContentLength > this.MAX_ARCHIVE_SIZE) {
        throw new Error('Archive too large for extraction');
      }

      const tempTarPath = `/tmp/snapshot-${sandboxId}.tar`;
      await fs.writeFile(tempTarPath, response.Body);

      const extractDir = `/var/lib/preview/projects/${sandboxId}`;
      await fs.mkdir(extractDir, { recursive: true });

      // Pre-scan tar file for decompression bomb protection
      const MAX_EXTRACTED = 100 * 1024 * 1024; // 100MB
      const MAX_FILES = 1000;

      const stat = await fs.stat(tempTarPath);
      const tarSize = stat.size;

      let preScanBytes = 0;
      let preScanFiles = 0;

      try {
        await tar.t({
          file: tempTarPath,
          onentry: (entry) => {
            preScanFiles++;
            preScanBytes += entry.size || 0;

            if (preScanFiles > MAX_FILES) {
              throw new Error(`Archive file count exceeded - max ${MAX_FILES}, found ${preScanFiles}`);
            }

            if (preScanBytes > MAX_EXTRACTED) {
              throw new Error(`Archive extracted size limit exceeded - max ${MAX_EXTRACTED}, found ${preScanBytes}`);
            }

            if (tarSize > 0 && preScanBytes > tarSize * 50) { // >50x compression ratio check
              throw new Error(`Suspicious compression ratio - extracted bytes ${preScanBytes} exceeds tar size ${tarSize} by >50x`);
            }
          }
        });

        logger.info(`Tar pre-scan completed successfully`, {
          operation: 'tar_scan',
          sandboxId,
          fileCount: preScanFiles,
          extractedSize: preScanBytes,
          compressionRatio: tarSize > 0 ? (preScanBytes / tarSize).toFixed(2) : 'unknown'
        });
      } catch (scanError) {
        logger.warn(`Tar pre-scan failed for security limits`, {
          operation: 'tar_scan',
          sandboxId,
          error: scanError.message
        });
        // Clean up partial extraction
        await fs.rm(extractDir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`Tar archive failed security scan: ${scanError.message}`);
      }

      // Proceed with safe extract with existing filter
      // Track extracted size for additional verification during extraction
      let extractedSize = 0;
      let filesExtracted = 0;

      await tar.extract({
        file: tempTarPath,
        cwd: extractDir,
        filter: (p, stat) => {
          // Path validation
          if (p.startsWith('/') || p.includes('..') || stat.type === 'SymbolicLink') {
            return false;
          }

          // File count validation
          filesExtracted++;
          if (filesExtracted > MAX_FILES) {
            logger.error(`Too many files in archive: ${filesExtracted}`);
            throw new Error(`Archive contains too many files. Maximum ${MAX_FILES} allowed.`);
          }

          // Size validation for decompression bomb protection
          extractedSize += stat.size;
          if (extractedSize > this.MAX_EXTRACT_SIZE) {
            logger.error(`Extracted files size limit exceeded: ${extractedSize} > ${this.MAX_EXTRACT_SIZE}`);
            throw new Error(`Extracted files exceed maximum size limit of ${this.MAX_EXTRACT_SIZE} bytes`);
          }

          // Individual file size validation
          if (stat.size > 50 * 1024 * 1024) { // 50MB per file limit
            logger.error(`File too large in archive: ${p} (${stat.size} bytes)`);
            throw new Error(`File ${p} exceeds maximum size of 50MB`);
          }

          return true;
        }
      });

      // Final validation with actual extracted data
      const compressionRatio = tarSize > 0 ? extractedSize / tarSize : 0;
      if (compressionRatio > this.MAX_COMPRESSION_RATIO) {
        logger.warn(`Suspicious compression ratio detected`, {
          operation: 'extract_validation',
          sandboxId,
          compressionRatio: compressionRatio.toFixed(2),
          compressThreshold: this.MAX_COMPRESSION_RATIO,
          tarSize,
          extractedSize
        });
      }

      logger.info(`Tar extraction completed`, {
        operation: 'extract_decompression',
        sandboxId,
        fileCount: filesExtracted,
        extractedSize,
        compressionRatio: compressionRatio.toFixed(2),
        validation: {
          maxFiles: preScanFiles <= MAX_FILES,
          maxBytes: preScanBytes <= MAX_EXTRACTED,
          compressionCheck: tarSize > 0 ? compressionRatio <= this.MAX_COMPRESSION_RATIO : 'skipped'
        }
      });

      // Cleanup temp tar
      await fs.unlink(tempTarPath);

      logger.info(`Snapshot extracted for sandbox ${sandboxId}`);
      return extractDir;
    } catch (error) {
      logger.error(`Failed to get snapshot for sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  async storeBuildArtifacts(sandboxId, buildDir) {
    try {
      // Create tar of build artifacts
      const tarPath = `/tmp/build-${sandboxId}.tar`;
      await tar.create({
        cwd: buildDir,
        file: tarPath
      }, ['.next']);

      const fileStream = createReadStream(tarPath);
      await this.s3.upload({
        Bucket: this.bucket,
        Key: `sandbox/${sandboxId}/build.tar`,
        Body: fileStream,
        ContentType: 'application/x-tar'
      }).promise();

      logger.info(`Build artifacts stored for sandbox ${sandboxId}`);

      // Cleanup
      await fs.unlink(tarPath);

      return true;
    } catch (error) {
      logger.error(`Failed to store build artifacts for sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  async deleteSandboxData(sandboxId) {
    try {
      const objects = await this.s3.listObjectsV2({
        Bucket: this.bucket,
        Prefix: `sandbox/${sandboxId}/`
      }).promise();

      if (objects.Contents.length > 0) {
        await this.s3.deleteObjects({
          Bucket: this.bucket,
          Delete: {
            Objects: objects.Contents.map(obj => ({ Key: obj.Key }))
          }
        }).promise();
      }

      logger.info(`Sandbox data deleted for sandbox ${sandboxId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete sandbox data for sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  async storeDependencyCache(lockfileHash, pnpmStorePath) {
    try {
      const tarPath = `/tmp/cache-${lockfileHash}.tar`;
      await tar.create({
        cwd: pnpmStorePath,
        file: tarPath
      }, ['.']);

      const fileStream = createReadStream(tarPath);
      await this.s3.upload({
        Bucket: this.bucket,
        Key: `cache/${lockfileHash}/pnpm-store.tar`,
        Body: fileStream,
        ContentType: 'application/x-tar'
      }).promise();

      logger.info(`Dependency cache stored for hash ${lockfileHash}`);

      // Cleanup
      await fs.unlink(tarPath);

      return true;
    } catch (error) {
      logger.error(`Failed to store dependency cache for hash ${lockfileHash}:`, error);
      throw error;
    }
  }

  async getDependencyCache(lockfileHash, targetDir) {
    try {
      const getObjectParams = {
        Bucket: this.bucket,
        Key: `cache/${lockfileHash}/pnpm-store.tar`
      };

      const response = await this.s3.getObject(getObjectParams).promise();
      const tempTarPath = `/tmp/cache-${lockfileHash}.tar`;

      await fs.writeFile(tempTarPath, response.Body);
      await fs.mkdir(targetDir, { recursive: true });

      await tar.extract({
        file: tempTarPath,
        cwd: targetDir
      });

      // Cleanup
      await fs.unlink(tempTarPath);

      logger.info(`Dependency cache retrieved for hash ${lockfileHash}`);
      return true;
    } catch (error) {
      if (error.code === 'NoSuchKey') {
        logger.info(`No dependency cache found for hash ${lockfileHash}`);
        return false;
      }
      logger.error(`Failed to get dependency cache for hash ${lockfileHash}:`, error);
      throw error;
    }
  }
}

module.exports = StorageService;