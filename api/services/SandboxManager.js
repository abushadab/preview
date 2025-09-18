const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const logger = require('../utils/logger');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class SandboxManager {
  constructor() {
    this.docker = new Docker();
    this.redis = null;
    this.queueService = null;
    this.storageService = null;
    this.sendLogToClient = null;
    this.activeSandboxes = new Map();
    this.logsStream = new Map();
  }

  async initialize({ queueService, storageService, sendLogToClient }) {
    this.queueService = queueService;
    this.storageService = storageService;
    this.sendLogToClient = sendLogToClient;

    try {
      // Initialize Redis connection
      this.redis = new Redis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false
      });

      await this.redis.ping();
      logger.info('SandboxManager Redis connection established');

      await this.storageService.initialize();
      await this.queueService.setWorkers(this);

      // Cleanup any existing orphaned containers
      await this.cleanupOrphanedContainers();

      logger.info('SandboxManager initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize SandboxManager:', error);
      throw error;
    }
  }

  async cleanupOrphanedContainers() {
    try {
      logger.info('Starting orphaned container cleanup process', {
        operation: 'container_prune',
        phase: 'started'
      });

      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: ['sandbox=true'] }
      });

      logger.debug('Found containers for pruning', {
        operation: 'container_prune',
        phase: 'analysis',
        totalContainers: containers.length
      });

      let cleanupResults = {
        total: containers.length,
        removed: 0,
        skipped: 0,
        errors: 0,
        details: []
      };

      for (const containerInfo of containers) {
        const container = this.docker.getContainer(containerInfo.Id);
        const sandboxId = containerInfo.Labels['sandbox-id'];

        if (!sandboxId) {
          cleanupResults.skipped++;
          continue;
        }

        try {
          const inspectResult = await container.inspect();
          if (inspectResult.State.Status !== 'running') {
            await container.remove({ force: true });
            cleanupResults.removed++;
            cleanupResults.details.push({
              sandboxId,
              action: 'removed',
              reason: 'container_not_running',
              status: inspectResult.State.Status
            });
            logger.info(`Cleaned up orphaned container for sandbox ${sandboxId}`, {
              operation: 'container_prune',
              sandboxId,
              status: inspectResult.State.Status
            });
          } else {
            cleanupResults.skipped++;
            cleanupResults.details.push({
              sandboxId,
              action: 'skipped',
              reason: 'container_running',
              status: inspectResult.State.Status
            });
          }
        } catch (error) {
          await container.remove({ force: true });
          cleanupResults.removed++;
          cleanupResults.errors++; // Don't skip error count for force removal
          cleanupResults.details.push({
            sandboxId,
            action: 'force_removed',
            reason: 'inspection_failed',
            error: error.message
          });
          logger.warn(`Force removed orphaned container for sandbox ${sandboxId}`, {
            operation: 'container_prune',
            sandboxId,
            error: error.message
          });
        }
      }

      logger.info('Orphaned container cleanup completed', {
        operation: 'container_prune',
        phase: 'completed',
        results: cleanupResults
      });

      return cleanupResults;
    } catch (error) {
      logger.error('Error during orphaned container cleanup process', {
        operation: 'container_prune',
        phase: 'failed',
        error: error.message,
        code: error.code
      });
      throw error;
    }
  }

  async buildProductionSandbox(sandboxData) {
    try {
      logger.info(`Building production sandbox ${sandboxData.id}`);
      this.sendLogToClient(sandboxData.id, `Starting production build for sandbox ${sandboxData.id}`);

      // Extract sandbox files
      const projectDir = await this.storageService.getSnapshot(sandboxData.id);

      // Build Docker image
      const imageName = `sbx:${sandboxData.id}`;
      await this.buildDockerImage(sandboxData.id, projectDir, imageName);

      // Run container
      await this.startProductionContainer(sandboxData, imageName);

      // Update sandbox status
      const sandboxInfo = {
        ...sandboxData,
        status: 'running',
        startedAt: new Date().toISOString()
      };

      this.activeSandboxes.set(sandboxData.id, sandboxInfo);

      // Store in Redis for TTL tracking
      await this.redis.setex(
        `sandbox:${sandboxData.id}`,
        sandboxData.ttl * 60, // Convert minutes to seconds
        JSON.stringify(sandboxInfo)
      );

      this.sendLogToClient(sandboxData.id, `Sandbox ${sandboxData.id} is ready at ${sandboxData.url}`);

      // Cleanup temp files
      await fs.rm(projectDir, { recursive: true, force: true });

      return { success: true, url: sandboxData.url };
    } catch (error) {
      logger.error(`Failed to build production sandbox ${sandboxData.id}:`, error);
      this.sendLogToClient(sandboxData.id, `Error: ${error.message}`);
      throw error;
    }
  }

  async buildDevSandbox(sandboxData) {
    try {
      logger.info(`Building dev sandbox ${sandboxData.id}`);
      this.sendLogToClient(sandboxData.id, `Starting dev build for sandbox ${sandboxData.id}`);

      // Extract sandbox files
      const projectDir = await this.storageService.getSnapshot(sandboxData.id);

      // Run dev container
      await this.startDevContainer(sandboxData, projectDir);

      // Update sandbox status
      const sandboxInfo = {
        ...sandboxData,
        status: 'running',
        startedAt: new Date().toISOString()
      };

      this.activeSandboxes.set(sandboxData.id, sandboxInfo);

      // Store in Redis for TTL tracking
      await this.redis.setex(
        `sandbox:${sandboxData.id}`,
        sandboxData.ttl * 60, // Convert minutes to seconds
        JSON.stringify(sandboxInfo)
      );

      this.sendLogToClient(sandboxData.id, `Sandbox ${sandboxData.id} is ready at ${sandboxData.url}`);

      // Don't cleanup project dir for dev containers (might need it for rebuilds)

      return { success: true, url: sandboxData.url };
    } catch (error) {
      logger.error(`Failed to build dev sandbox ${sandboxData.id}:`, error);
      this.sendLogToClient(sandboxData.id, `Error: ${error.message}`);
      throw error;
    }
  }

  async buildDockerImage(sandboxId, projectDir, imageName) {
    try {
      this.sendLogToClient(sandboxId, 'Building Docker image...');

      const buildOptions = {
        dockerfile: path.join(__dirname, '../../images/nextjs-standalone.Dockerfile'),
        context: projectDir,
        buildargs: {
          NODE_ENV: 'production'
        }
      };

      const stream = await this.docker.buildImage(buildOptions);

      return new Promise((resolve, reject) => {
        let buildOutput = '';

        this.docker.modem.followProgress(stream, (err, res) => {
          if (err) {
            reject(err);
          } else {
            resolve(res);
          }
        }, (event) => {
          if (event.stream) {
            buildOutput += event.stream;
            this.sendLogToClient(sandboxId, `Build: ${event.stream.trim()}`);
          }
          if (event.error || event.errorDetail) {
            const errorMsg = event.error || event.errorDetail.message;
            this.sendLogToClient(sandboxId, `Build Error: ${errorMsg}`);
            reject(new Error(errorMsg));
          }
        });
      });
    } catch (error) {
      logger.error(`Failed to build Docker image for sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  async startProductionContainer(sandboxData, imageName) {
    try {
      const containerName = `sbx-${sandboxData.id}`;
      const containerOptions = {
        name: containerName,
        Image: imageName,
        Env: [
          `NODE_ENV=production`,
          `PORT=3000`
        ],
        ExposedPorts: {
          '3000/tcp': {}
        },
        HostConfig: {
          PortBindings: {
            '3000/tcp': [{ HostPort: '0' }]
          },
          Memory: this.parseMemoryLimit(process.env.DEFAULT_MEM_PROD || '256m'),
          CpuQuota: Math.floor(parseFloat(process.env.DEFAULT_CPU_PROD || '0.25') * 100000),
          CpuPeriod: 100000,
          PidsLimit: 256,
          NetworkMode: process.env.DOCKER_NETWORK || 'bridge',
          // Security hardening parity with dev containers
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          ReadonlyRootfs: true, // Immutable root filesystem
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,size=100m',
            '/var/log': 'rw,noexec,nosuid,size=50m'  // For production logging
          }
        },
        Labels: {
          'sandbox': 'true',
          'sandbox-id': sandboxData.id,
          'sandbox-mode': sandboxData.mode,
          'traefik.enable': 'true',
          ['traefik.http.routers.sbx-' + sandboxData.id + '.rule']: `Host(\`${sandboxData.id}.${process.env.PREVIEW_DOMAIN}\`)`,
          ['traefik.http.routers.sbx-' + sandboxData.id + '.entrypoints']: 'web'
        }
      };

      const container = await this.docker.createContainer(containerOptions);
      await container.start();

      // Setup log stream
      await this.setupLogStream(sandboxData.id, container);

      // Wait for health check
      await this.waitForHealthCheck(sandboxData.id, '3000', 30, sandboxData.healthPath);

      logger.info(`Production container started for sandbox ${sandboxData.id}`);
    } catch (error) {
      logger.error(`Failed to start production container for sandbox ${sandboxData.id}:`, error);
      throw error;
    }
  }

  async ensureImage(docker, image, logFn) {
    try {
      await docker.getImage(image).inspect();
      logFn(`Image ${image} already exists, skipping pull`);
      return;
    } catch (_) {}

    logFn(`Pulling image ${image}...`);
    const stream = await docker.pull(image);

    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => {
        if (err) reject(err);
        else resolve();
      }, (event) => {
        if (event.status) {
          logFn(`pull ${image}: ${event.status} ${event.progress || ''}`.trim());
        }
      });
    });
  }

  async removeIfExists(docker, name) {
    try {
      const container = docker.getContainer(name);
      await container.inspect();
      await container.remove({ force: true, v: true });
      logger.info(`Removed existing container ${name}`);
    } catch (_) {}
  }

  async probe(url, ms) {
    const probeStartTime = Date.now();

    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), ms);
      const response = await fetch(url, { signal: ac.signal });
      clearTimeout(timeout);

      const duration = Date.now() - probeStartTime;
      const success = response.ok;

      return success;
    } catch (error) {
      const duration = Date.now() - probeStartTime;
      logger.debug('Probe request failed', {
        operation: 'health_probe',
        url,
        duration,
        error: error.message,
        errorType: 'probe_exception'
      });
      return false;
    }
  }

  async probeWithHost(url, host, ms) {
    const probeStartTime = Date.now();
    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), ms);
      const response = await fetch(url, {
        signal: ac.signal,
        headers: { 'Host': host }
      });
      clearTimeout(timeout);
      return response.ok;
    } catch (error) {
      const duration = Date.now() - probeStartTime;
      logger.debug('Probe request with host failed', {
        operation: 'health_probe',
        url,
        host,
        duration,
        error: error.message,
        errorType: 'probe_exception'
      });
      return false;
    }
  }

  async startDevContainer(sandboxData, projectDir) {
    try {
      const containerName = `sbx-${sandboxData.id}`;

      // Ensure image exists
      await this.ensureImage(this.docker, 'node:20-bullseye', (m) => this.sendLogToClient(sandboxData.id, m));

      // Remove existing container if it exists
      await this.removeIfExists(this.docker, containerName);

      const containerOptions = {
        name: containerName,
        Image: 'node:20-bullseye',
        // Wait for files to be copied into /work (tmpfs) before starting app
        // This ensures ReadonlyRootfs does not block file placement and avoids race conditions
        Cmd: ['bash', '-lc', 'while [ ! -f /work/.ready ]; do sleep 0.5; done; npm i && (npm run dev || npm start || node server.js)'],
        Env: [
          `PORT=3000`,
          `PNPM_HOME=/home/node/.local/share/pnpm`,
          `NPM_CONFIG_CACHE=/home/node/.local/.npm`,
          `NPM_CONFIG_TMP=/tmp`,
          `NEXT_TELEMETRY_DISABLED=1`,
          `SANDBOX_ID=${sandboxData.id}`,
          ...Object.entries(sandboxData.env || {}).map(([key, value]) => `${key}=${value}`)
        ],
        User: 'node', // Run as non-root user for security
        ExposedPorts: {
          '3000/tcp': {}
        },
        WorkingDir: '/work',
        Labels: {
          'sandbox': 'true',
          'sandbox-id': sandboxData.id,
          'sandbox-mode': sandboxData.mode,
          'traefik.enable': 'true',
          ['traefik.http.routers.sbx-' + sandboxData.id + '.rule']: `Host(\`${sandboxData.id}.${process.env.PREVIEW_DOMAIN}\`)`,
          ['traefik.http.routers.sbx-' + sandboxData.id + '.entrypoints']: 'web'
        },
        HostConfig: {
          PortBindings: {
            '3000/tcp': [{ HostPort: '0' }]
          },
          Memory: this.parseMemoryLimit(process.env.DEFAULT_MEM || '768m'),
          CpuQuota: Math.floor(parseFloat(process.env.DEFAULT_CPU || '0.75') * 100000),
          CpuPeriod: 100000,
          PidsLimit: 256,
          NetworkMode: process.env.DOCKER_NETWORK || 'bridge',
          // Security hardening
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          ReadonlyRootfs: true, // Immutable root filesystem
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,size=100m',
            '/home/node/.local': 'rw,noexec,nosuid,size=200m,uid=1000,gid=1000',
            '/work': 'rw,nosuid,exec,size=500m,uid=1000,gid=1000'  // Allow exec for node_modules/.bin scripts - node user owns /work
          }
        }
      };

      // Separate HostConfig from other container options for better structure
      const hostConfig = containerOptions.HostConfig;
      delete containerOptions.HostConfig;

      const containerCreateOptions = {
        ...containerOptions,
        HostConfig: hostConfig
      };

      const container = await this.docker.createContainer(containerCreateOptions);

      // Start container first so tmpfs mounts (including /work) are materialized
      await container.start();

      this.sendLogToClient(sandboxData.id, `Container started as non-root user 'node' with enhanced security`);

      // Setup log stream
      await this.setupLogStream(sandboxData.id, container);

      // Copy files from project directory to container using Docker API once /work exists (Fix: Start -> Copy -> Signal)
      try {
        logger.info(`Copying files to container ${sandboxData.id} at /work`);

        const tar = require('tar');

        // Robustly wait for /work tmpfs to be mounted and writable
        const waitMountReady = async () => {
          const maxAttempts = 120; // ~30s
          for (let i = 0; i < maxAttempts; i++) {
            try {
              const ex = await container.exec({
                Cmd: ['bash', '-lc', '(mountpoint -q /work || grep -q "on /work type tmpfs" /proc/mounts) && [ -w /work ] && echo READY || echo NOTREADY'],
                AttachStdout: true,
                AttachStderr: true
              });
              const ok = await new Promise((resolve, reject) => {
                ex.start((err, stream) => {
                  if (err) return reject(err);
                  let out = '';
                  stream.on('data', (chunk) => { out += chunk.toString('utf8'); });
                  stream.on('end', () => resolve(out.includes('READY')));
                  stream.on('error', reject);
                });
              });
              if (ok) return true;
            } catch (_) {}
            await new Promise(r => setTimeout(r, 250));
          }
          throw new Error('Timeout waiting for /work tmpfs to be ready');
        };

        await waitMountReady();

        // Use in-container extraction via exec to bypass Docker putArchive rootfs checks
        const extractViaExec = async () => {
          const execInstance = await container.exec({
            Cmd: ['bash', '-lc', 'tar --no-same-owner -x -f - -C /work'],
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            WorkingDir: '/work'
          });

          await new Promise((resolve, reject) => {
            execInstance.start({ hijack: true, stdin: true }, (err, stream) => {
              if (err) return reject(err);
              const tarStream = tar.create({ gzip: false, cwd: projectDir }, ['.']);

              // Pipe tar into exec stdin
              tarStream.pipe(stream);

              let stderr = '';
              // Demux stdout/stderr to drain
              if (container.modem && container.modem.demuxStream) {
                const { PassThrough } = require('stream');
                const out = new PassThrough();
                const errOut = new PassThrough();
                errOut.on('data', chunk => { stderr += chunk.toString('utf8'); });
                container.modem.demuxStream(stream, out, errOut);
              } else {
                stream.on('data', () => {});
              }

              tarStream.on('error', reject);
              stream.on('error', reject);
              stream.on('end', () => {
                if (stderr.trim().length > 0) return reject(new Error(stderr.trim()));
                resolve();
              });
            });
          });
        };

        await extractViaExec();

        // Verify that essential files arrived before signaling ready
        try {
          const verify = await container.exec({
            Cmd: ['bash', '-lc', 'set -e; ls -la /work | head -n 50; if [ -f /work/package.json ] || [ -f /work/server.js ] || [ -f /work/app/page.tsx ] || [ -f /work/app/page.js ]; then echo OK; else echo MISSING; fi'],
            AttachStdout: true,
            AttachStderr: true,
            WorkingDir: '/work'
          });
          const ok = await new Promise((resolve, reject) => {
            verify.start((err, stream) => {
              if (err) return reject(err);
              let output = '';
              stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
              stream.on('end', () => resolve(output.includes('OK')));
              stream.on('error', reject);
            });
          });
          if (!ok) {
            throw new Error('Post-extract verification failed: expected app files not found in /work');
          }
        } catch (verr) {
          logger.error(`Verification after extract failed for sandbox ${sandboxData.id}:`, verr);
          throw verr;
        }

        this.sendLogToClient(sandboxData.id, `Successfully copied files to /work`);

        // Signal the container to proceed (release wait loop)
        const exec = await container.exec({
          Cmd: ['bash', '-lc', 'touch /work/.ready'],
          AttachStdout: true,
          AttachStderr: true,
          WorkingDir: '/work'
        });
        await new Promise((resolve, reject) => {
          exec.start((err, stream) => {
            if (err) return reject(err);
            stream.on('end', resolve);
            stream.on('error', reject);
          });
        });

        this.sendLogToClient(sandboxData.id, `Signaled container to start application`);
      } catch (error) {
        logger.error(`Failed to copy files or signal start for sandbox ${sandboxData.id}:`, error);
        this.sendLogToClient(sandboxData.id, `Error during file copy/start signal: ${error.message}`);
        // Abort startup so health check does not spin on a non-started app
        throw error;
      }

      // Wait for health check
      await this.waitForHealthCheck(sandboxData.id, '3000', 30, sandboxData.healthPath);

      logger.info(`Dev container started for sandbox ${sandboxData.id}`);
    } catch (error) {
      logger.error(`Failed to start dev container for sandbox ${sandboxData.id}:`, error);
      throw error;
    }
  }

  async setupLogStream(sandboxId, container) {
    try {
      const stream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
        tail: 100
      });

      this.logsStream.set(sandboxId, stream);

      stream.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split('\n').filter(line => line.trim());
        lines.forEach(line => {
          this.sendLogToClient(sandboxId, line);
        });
      });

      stream.on('error', (error) => {
        logger.error(`Log stream error for sandbox ${sandboxId}:`, error);
        this.sendLogToClient(sandboxId, `Log stream error: ${error.message}`);
      });

      stream.on('end', () => {
        logger.info(`Log stream ended for sandbox ${sandboxId}`);
        this.logsStream.delete(sandboxId);
      });

    } catch (error) {
      logger.error(`Failed to setup log stream for sandbox ${sandboxId}:`, error);
    }
  }

  async probeWithHost(url, host, ms) {
    const probeStartTime = Date.now();
    try {
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), ms);
      const response = await fetch(url, { signal: ac.signal, headers: { Host: host } });
      clearTimeout(timeout);
      return response.ok;
    } catch (error) {
      const duration = Date.now() - probeStartTime;
      logger.debug('Probe request (host) failed', {
        operation: 'health_probe',
        url,
        host,
        duration,
        error: error.message,
        errorType: 'probe_exception'
      });
      return false;
    }
  }

  async waitForHealthCheck(sandboxId, port, maxAttempts = 30, healthPath) {
    const startTime = Date.now();
    const healthCheckId = `hc-${sandboxId}-${Date.now()}`;

    try {
      this.sendLogToClient(sandboxId, `Waiting for health check on port ${port}...`);

      logger.info(`Starting health check process`, {
        operation: 'health_probe',
        healthCheckId,
        sandboxId,
        port,
        healthPath,
        maxAttempts,
        phase: 'started'
      });

      // Health check paths preference: '/' first for acceptance evidence
      const paths = [
        '/',
        healthPath || '/health',
        '/api/health'
      ];

      let attemptResults = [];

      for (let i = 0; i < maxAttempts; i++) {
        const attemptStartTime = Date.now();
        let attemptResult = {
          attempt: i + 1,
          startTime: attemptStartTime,
          paths: []
        };

        try {
          const container = this.docker.getContainer(`sbx-${sandboxId}`);
          const info = await container.inspect();

          if (info.State.Status !== 'running') {
            throw new Error('Container is not running');
          }

          // Prefer host port if bound; else probe through Traefik with Host header
          const ports = info.NetworkSettings.Ports || {};
          const portBindings = ports[`${port}/tcp`];
          const usingHostPort = Array.isArray(portBindings) && portBindings.length > 0;
          const hostHeader = `${sandboxId}.${process.env.PREVIEW_DOMAIN}`;
          const baseUrl = usingHostPort ? (path => `http://localhost:${portBindings[0].HostPort}${path}`) : (path => `http://traefik${path}`);

          // Try each path with proper timeout
          for (const p of paths) {
            const pathStartTime = Date.now();
            this.sendLogToClient(sandboxId, `Trying health check at ${p}...`);

            const probeResult = usingHostPort
              ? await this.probe(baseUrl(p), 5000)
              : await this.probeWithHost(baseUrl(p), hostHeader, 5000);

            const pathEndTime = Date.now();

            attemptResult.paths.push({
              path: p,
              success: probeResult,
              duration: pathEndTime - pathStartTime,
              url: baseUrl(p)
            });

            if (probeResult) {
              const totalDuration = Date.now() - startTime;
              this.sendLogToClient(sandboxId, `Health check passed at ${p}`);

              logger.info(`Health check completed successfully`, {
                operation: 'health_probe',
                healthCheckId,
                sandboxId,
                successfulPath: p,
                attempts: i + 1,
                totalDuration,
                phase: 'completed',
                attemptResults
              });

              return true;
            }
          }

          // Check if all paths failed within this attempt
          const allPathsFailed = attemptResult.paths.length > 0 &&
                                !attemptResult.paths.some(p => p.success);

          if (allPathsFailed) {
            // Record that this attempt failed
            attemptResult.success = false;
            attemptResult.error = 'All health check paths failed';
            logger.debug(`Health check attempt ${i + 1} - all paths failed`, {
              operation: 'health_probe',
              healthCheckId,
              sandboxId,
              attempt: i + 1,
              pathsAttempted: attemptResult.paths.length,
              failedPaths: attemptResult.paths.filter(p => !p.success).map(p => p.path)
            });
          }

          attemptResult.endTime = Date.now();
          attemptResult.duration = attemptResult.endTime - attemptStartTime;
          attemptResults.push(attemptResult);

        } catch (error) {
          // Health check failed, log structured error
          const attemptDuration = Date.now() - attemptStartTime;
          attemptResult.endTime = Date.now();
          attemptResult.duration = attemptDuration;
          attemptResult.error = error.message;
          attemptResults.push(attemptResult);

          if (i === maxAttempts - 1) {
            const totalDuration = Date.now() - startTime;
            logger.error(`Health check failed after maximum attempts`, {
              operation: 'health_probe',
              healthCheckId,
              sandboxId,
              attempts: maxAttempts,
              totalDuration,
              phase: 'failed',
              finalError: error.message,
              attemptResults,
              errorType: 'max_attempts_exceeded'
            });
            throw new Error(`Health check failed after ${maxAttempts} attempts: ${error.message}`);
          }

          logger.debug(`Health check attempt ${i + 1} failed`, {
            operation: 'health_probe',
            healthCheckId,
            sandboxId,
            attempt: i + 1,
            duration: attemptDuration,
            error: error.message,
            attemptResult
          });

          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      const totalDuration = Date.now() - startTime;
      logger.warn(`Health check timed out`, {
        operation: 'health_probe',
        healthCheckId,
        sandboxId,
        attempts: maxAttempts,
        totalDuration,
        phase: 'timeout',
        attemptResults,
        errorType: 'timeout'
      });

      throw new Error(`Health check timed out after ${maxAttempts} attempts`);
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      logger.error(`Health check process error`, {
        operation: 'health_probe',
        healthCheckId,
        sandboxId,
        totalDuration,
        phase: 'error',
        error: error.message,
        errorType: error.name || 'unknown'
      });
      throw error;
    }
  }

  async getSandboxStatus(sandboxId) {
    try {
      const sandbox = this.activeSandboxes.get(sandboxId);

      if (!sandbox) {
        return null;
      }

      // Check container status
      const container = this.docker.getContainer(`sbx-${sandboxId}`);
      const info = await container.inspect();

      return {
        ...sandbox,
        containerStatus: info.State.Status,
        startedAt: info.State.StartedAt,
        health: info.State.Health?.Status || 'unknown'
      };
    } catch (error) {
      logger.error(`Failed to get sandbox status for ${sandboxId}:`, error);
      return null;
    }
  }

  async stopSandbox(sandboxId) {
    try {
      logger.info(`Stopping sandbox ${sandboxId}`);

      // Stop log stream
      const logStream = this.logsStream.get(sandboxId);
      if (logStream) {
        logStream.destroy();
        this.logsStream.delete(sandboxId);
      }

      // Stop and remove container
      const container = this.docker.getContainer(`sbx-${sandboxId}`);
      try {
        await container.remove({ force: true, v: true });
      } catch (error) {
        if (!error.message.includes('No such container')) {
          throw error;
        }
      }

      // Remove from active sandboxes
      this.activeSandboxes.delete(sandboxId);

      // Remove from Redis (guard against missing services)
      if (this.redis) {
        await this.redis.del(`sandbox:${sandboxId}`);
      }

      // Clean up storage
      if (this.storageService) {
        await this.storageService.deleteSandboxData(sandboxId);
      }

      logger.info(`Sandbox ${sandboxId} stopped successfully`);
      return true;
    } catch (error) {
      logger.error(`Failed to stop sandbox ${sandboxId}:`, error);
      throw error;
    }
  }

  parseMemoryLimit(memoryStr) {
    const units = { b: 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 };
    const match = memoryStr.toLowerCase().match(/^(\d+)([kmg]?)$/);

    if (!match) {
      return 256 * 1024 * 1024; // Default 256MB
    }

    const size = parseInt(match[1], 10);
    const unit = match[2] || 'b';

    return size * units[unit];
  }

  async close() {
    try {
      // Stop all active sandboxes
      const sandboxIds = Array.from(this.activeSandboxes.keys());
      for (const sandboxId of sandboxIds) {
        await this.stopSandbox(sandboxId);
      }

      // Close Redis connection
      if (this.redis) {
        await this.redis.quit();
      }

      logger.info('SandboxManager closed successfully');
    } catch (error) {
      logger.error('Error closing SandboxManager:', error);
      throw error;
    }
  }
}

module.exports = SandboxManager;
