const cron = require('node-cron');
const logger = require('../utils/logger');
const Redis = require('ioredis');
const Docker = require('dockerode');

class CleanupJob {
  constructor() {
    this.redisConnection = null;
    this.docker = new Docker();
  }

  async initialize() {
    this.redisConnection = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false
    });

    await this.redisConnection.ping();
    logger.info('Cleanup job Redis connection established');
  }

  start() {
    // Run every minute
    cron.schedule('* * * * *', async () => {
      try {
        await this.cleanupExpiredSandboxes();
        await this.cleanupDockerResources();
      } catch (error) {
        logger.error('Error in cleanup job:', error);
      }
    });

    logger.info('Cleanup job started - runs every minute');
  }

  async cleanupExpiredSandboxes() {
    try {
      const sandboxKeys = await this.redisConnection.keys('sandbox:*');

      if (sandboxKeys.length === 0) {
        return;
      }

      const now = Date.now();

      for (const key of sandboxKeys) {
        const sandboxData = await this.redisConnection.get(key);
        if (!sandboxData) continue;

        const sandbox = JSON.parse(sandboxData);

        if (new Date(sandbox.expiresAt).getTime() <= now) {
          logger.info(`Cleaning up expired sandbox ${sandbox.id}`);

          // Stop the sandbox
          const SandboxManager = require('../services/SandboxManager');
          const sandboxManager = new SandboxManager();

          try {
            await sandboxManager.stopSandbox(sandbox.id);
          } catch (error) {
            logger.error(`Error stopping sandbox ${sandbox.id}:`, error);
          }

          // Remove from Redis
          await this.redisConnection.del(key);

          logger.info(`Expired sandbox ${sandbox.id} cleaned up successfully`);
        }
      }
    } catch (error) {
      logger.error('Error cleaning up expired sandboxes:', error);
    }
  }

  async cleanupDockerResources() {
    try {
      logger.info('Starting Docker resource cleanup...');

      // Remove stopped sandbox containers
      const containerResult = await this.docker.pruneContainers({
        filters: { label: ['sandbox=true'] }
      });
      logger.info('Pruned containers:', containerResult);

      // Remove dangling images
      const imageResult = await this.docker.pruneImages({
        filters: { dangling: ['true'] }
      });
      logger.info('Pruned images:', imageResult);

      // Remove unused networks
      const networkResult = await this.docker.pruneNetworks();
      logger.info('Pruned networks:', networkResult);

      logger.info('Docker resource cleanup completed successfully');
    } catch (error) {
      logger.error('Error cleaning up Docker resources:', error);
    }
  }

  async close() {
    if (this.redisConnection) {
      await this.redisConnection.quit();
    }
  }
}

// This function will be exported and used by the main server
module.exports = function startCleanupJob() {
  const job = new CleanupJob();

  // Initialize and start in background
  job.initialize().then(() => {
    job.start();
  }).catch(error => {
    logger.error('Failed to initialize cleanup job:', error);
  });

  return job;
};

module.exports.CleanupJob = CleanupJob;