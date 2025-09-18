const { Queue, Worker } = require('bullmq');
const Redis = require('ioredis');
const logger = require('../utils/logger');

class QueueService {
  constructor() {
    this.redisConnection = null;
    this.buildQueue = null;
    this.devQueue = null;
    this.buildWorker = null;
    this.devWorker = null;
  }

  async initialize() {
    try {
      // Create Redis connection
      this.redisConnection = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      });

      // Test Redis connection
      await this.redisConnection.ping();
      logger.info('Redis connection established');

      // Create queues
      this.buildQueue = new Queue('buildQueue', {
        connection: this.redisConnection,
        defaultJobOptions: {
          removeOnComplete: 10,
          removeOnFail: 5,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000
          }
        }
      });

      this.devQueue = new Queue('devQueue', {
        connection: this.redisConnection,
        defaultJobOptions: {
          removeOnComplete: 10,
          removeOnFail: 5,
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 1000
          }
        }
      });

      logger.info('Queues initialized successfully');

    } catch (error) {
      logger.error('Failed to initialize QueueService:', error);
      throw error;
    }
  }

  async addToQueue(sandboxData) {
    try {
      const queue = sandboxData.mode === 'prod' ? this.buildQueue : this.devQueue;

      const job = await queue.add('provision-sandbox', sandboxData, {
        priority: sandboxData.mode === 'prod' ? 10 : 5
      });

      logger.info(`Added sandbox ${sandboxData.id} to ${sandboxData.mode} queue`, {
        jobId: job.id,
        mode: sandboxData.mode
      });

      return job;
    } catch (error) {
      logger.error('Failed to add job to queue:', error);
      throw error;
    }
  }

  async removeJob(jobId, queueName) {
    try {
      const queue = queueName === 'build' ? this.buildQueue : this.devQueue;
      await queue.remove(jobId);
      logger.info(`Removed job ${jobId} from ${queueName} queue`);
    } catch (error) {
      logger.error('Failed to remove job from queue:', error);
      throw error;
    }
  }

  async getJobStats() {
    try {
      const stats = {};

      if (this.buildQueue) {
        stats.build = {
          waiting: await this.buildQueue.getWaitingCount(),
          active: await this.buildQueue.getActiveCount(),
          delayed: await this.buildQueue.getDelayedCount(),
          failed: await this.buildQueue.getFailedCount(),
          completed: await this.buildQueue.getCompletedCount(),
        };
      }

      if (this.devQueue) {
        stats.dev = {
          waiting: await this.devQueue.getWaitingCount(),
          active: await this.devQueue.getActiveCount(),
          delayed: await this.devQueue.getDelayedCount(),
          failed: await this.devQueue.getFailedCount(),
          completed: await this.devQueue.getCompletedCount(),
        };
      }

      return stats;
    } catch (error) {
      logger.error('Failed to get job stats:', error);
      throw error;
    }
  }

  async getDebugInfo() {
    try {
      const stats = await this.getJobStats();

      const workers = {
        build: {
          attached: !!this.buildWorker,
          running: this.buildWorker && this.buildWorker.isRunning ? await this.buildWorker.isRunning() : false
        },
        dev: {
          attached: !!this.devWorker,
          running: this.devWorker && this.devWorker.isRunning ? await this.devWorker.isRunning() : false
        }
      };

      let redisPingMs = null;
      try {
        const start = Date.now();
        const pong = await this.redisConnection.ping();
        redisPingMs = pong ? Date.now() - start : null;
      } catch (_) {}

      return {
        redis: {
          url: process.env.REDIS_URL,
          pingMs: redisPingMs
        },
        queues: stats,
        workers
      };
    } catch (error) {
      logger.error('Failed to get queue debug info:', error);
      throw error;
    }
  }

  async setWorkers(sandboxManager) {
    try {
      // Create build worker for production sandboxes
      this.buildWorker = new Worker(
        'buildQueue',
        async (job) => {
          logger.info('Processing build job', { jobId: job.id, data: job.data });
          return await sandboxManager.buildProductionSandbox(job.data);
        },
        {
          connection: this.redisConnection,
          concurrency: parseInt(process.env.MAX_CONCURRENT_BUILDS) || 3,
          limiter: {
            max: 3,
            duration: 60000 // 1 minute
          }
        }
      );

      // Create dev worker for development sandboxes
      this.devWorker = new Worker(
        'devQueue',
        async (job) => {
          logger.info('Processing dev job', { jobId: job.id, data: job.data });
          return await sandboxManager.buildDevSandbox(job.data);
        },
        {
          connection: this.redisConnection,
          concurrency: 5,
          limiter: {
            max: 5,
            duration: 30000 // 30 seconds
          }
        }
      );

      // Event listeners
      [this.buildWorker, this.devWorker].forEach(worker => {
        worker.on('completed', (job) => {
          logger.info('Job completed', { jobId: job.id, result: job.returnvalue });
        });

        worker.on('failed', (job, err) => {
          logger.error('Job failed', { jobId: job.id, error: err.message });
        });

        worker.on('error', (err) => {
          logger.error('Worker error', { error: err.message });
        });
      });

      logger.info('Workers set up successfully');
    } catch (error) {
      logger.error('Failed to set up workers:', error);
      throw error;
    }
  }

  async close() {
    try {
      if (this.buildWorker) {
        await this.buildWorker.close();
      }
      if (this.devWorker) {
        await this.devWorker.close();
      }
      if (this.buildQueue) {
        await this.buildQueue.close();
      }
      if (this.devQueue) {
        await this.devQueue.close();
      }
      if (this.redisConnection) {
        await this.redisConnection.quit();
      }
      logger.info('QueueService closed successfully');
    } catch (error) {
      logger.error('Error closing QueueService:', error);
      throw error;
    }
  }
}

module.exports = QueueService;
