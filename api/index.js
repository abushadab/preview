require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { createServer } = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

// Ensure fetch is available (Node.js 18+)
let fetch;
if (global.fetch) {
  fetch = global.fetch;
} else {
  fetch = require('node-fetch');
}

const SandboxManager = require('./services/SandboxManager');
const QueueService = require('./services/QueueService');
const StorageService = require('./services/StorageService');
const logger = require('./utils/logger');
const URLGenerator = require('./utils/urlGenerator');
const { resolveEnv } = require('./utils/env');
const metrics = require('./utils/metrics');
const Docker = require('dockerode');

const app = express();
app.set('trust proxy', 1);
const server = createServer(app);
const wss = new WebSocketServer({ server });
const docker = new Docker();

// Middleware
app.use(helmet());
app.use(cors());

// Request ID middleware for observability
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.set('X-Request-ID', req.id);
  next();
});
app.use(metrics.requestObserver);

// Body limits with proper error handling
app.use(express.json({ limit: '10mb' })); // Reduced from 50mb to catch oversize
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Global error handler for entity too large
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: 'Payload too large. Maximum 10MB allowed.' });
  }
  next(err);
});

// Auth middleware for admin endpoints
const API_TOKEN = resolveEnv('API_TOKEN', { required: true });

function requireAuth(req, res, next) {
  const authHeader = req.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' });
  }
  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // Log successful auth for audit purposes
  logger.info(`Authorized request: ${req.method} ${req.path}`, {
    user: 'admin',
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.get('User-Agent')
  });

  next();
}

// Services
const urlGenerator = new URLGenerator();
const sandboxManager = new SandboxManager();
const queueService = new QueueService();
const storageService = new StorageService();

// Store active WebSocket connections by sandbox ID
const activeConnections = new Map();

// Health check
app.get('/health', (req, res) => {
  console.log(`GET /health endpoint reached (request ID: ${req.id})`);
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    git_sha: process.env.GIT_SHA || 'dev',
    image_tag: process.env.IMAGE_TAG || 'local',
    config_rev: process.env.CONFIG_REV || 'local',
    response_id: req.id
  });
});

app.get('/metrics', requireAuth, metrics.sendMetrics);

// Readiness check - check if sandbox container is actually serving
app.get('/sandbox/:id/ready', requireAuth, async (req, res) => {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = () => Number((process.hrtime.bigint() - startedAt) / BigInt(1e6));
  try {
    const name = `sbx-${req.params.id}`;
    const container = docker.getContainer(name);

    // Check if container exists and is running
    let info;
    try {
      info = await container.inspect();
    } catch (error) {
      if (error.statusCode === 404) {
        return res.status(404).json({ ready: false, reason: 'Sandbox not found', latency_ms: elapsedMs() });
      }
      throw error;
    }
    if (info.State?.Status !== 'running') {
      return res.status(503).json({ ready: false, reason: 'Container not running', status: info.State?.Status || 'unknown', latency_ms: elapsedMs() });
    }

    // Use container exec to test HTTP connectivity (works with Traefik-only networking)
    // Try different methods: curl -> wget -> node fetch
    let statusCode = 0;
    let method = '';
    let lastError = null;

    for (const testCmd of [
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000${req.query.path || '/'}`,
      `wget -q --spider --server-response http://127.0.0.1:3000${req.query.path || '/'} 2>&1 | awk '/^  HTTP/{print $2}' | head -1`,
      `node -e "require('node-fetch')('http://127.0.0.1:3000${req.query.path || '/'}').then(r=>console.log(r.status)).catch(()=>console.log(0))"`
    ]) {
      try {
        const exec = await container.exec({
          Cmd: ["sh", "-lc", testCmd],
          AttachStdout: true,
          AttachStderr: true
        });

        const stream = await exec.start({});
        let output = '';

        await new Promise((resolve, reject) => {
          stream.on('data', (chunk) => {
            output += chunk.toString();
          });

          stream.on('end', resolve);
          stream.on('error', () => resolve());

          // Timeout after 8 seconds
          setTimeout(() => reject(new Error('Health check timeout')), 8000);
        });

        statusCode = parseInt(output.trim()) || 0;
        method = testCmd.includes('curl') ? 'curl' : testCmd.includes('wget') ? 'wget' : 'node';

        if (statusCode > 0) break;
      } catch (error) {
        lastError = error;
        continue;
      }
    }
    const latencyMs = elapsedMs();
    const isHealthy = statusCode >= 200 && statusCode < 400;

    if (isHealthy) {
      return res.json({ ready: true, status: statusCode, latency_ms: latencyMs, method });
    }

    if (statusCode > 0) {
      return res.status(503).json({ ready: false, status: statusCode, latency_ms: latencyMs, method });
    }

    logger.warn('Sandbox readiness probe failed', {
      sandboxId: req.params.id,
      method: method || 'none',
      error: lastError ? lastError.message : 'unknown'
    });

    return res.status(503).json({ ready: false, status: 0, latency_ms: latencyMs, method: method || null, reason: 'Probe failed' });
  } catch (error) {
    logger.warn('Sandbox readiness probe error', {
      sandboxId: req.params.id,
      error: error.message
    });
    res.status(503).json({ ready: false, reason: 'Container not found or inaccessible', error: 'Probe failed', latency_ms: elapsedMs() });
  }
});

// Test endpoint
app.get('/test', (req, res) => {
  console.log('GET /test endpoint reached');
  res.json({ message: 'test endpoint works' });
});

// Debug: inspect sandbox container (read-only, filtered)
app.get('/sandbox/:id/inspect', requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const name = `sbx-${id}`;
    const container = docker.getContainer(name);
    const info = await container.inspect();
    const result = {
      id,
      name: info.Name?.replace('/', ''),
      image: info.Config?.Image,
      user: info.Config?.User || 'root',
      status: info.State?.Status,
      readonlyRootfs: info.HostConfig?.ReadonlyRootfs === true,
      tmpfs: info.HostConfig?.Tmpfs || {},
      created: info.Created,
    };
    res.json(result);
  } catch (error) {
    logger.error('Error inspecting sandbox container:', error);
    res.status(500).json({ error: 'Failed to inspect sandbox container' });
  }
});

// Debug: tail recent logs for a sandbox (read-only)
app.get('/sandbox/:id/logs/tail', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const name = `sbx-${id}`;
    const container = docker.getContainer(name);

    // Validate lines parameter
    const linesInput = req.query.lines || '50';
    if (!/^\d+$/.test(linesInput)) {
      return res.status(400).type('text/plain').send('Invalid lines parameter: must be a positive integer');
    }
    const lines = Math.min(parseInt(linesInput, 10), 1000);

    // Check if container exists first
    await container.inspect().catch(err => {
      if (err.statusCode === 404) {
        res.status(404).type('text/plain').send('Sandbox not found');
        throw new Error('Sandbox not found'); // Stop further processing
      }
      throw err;
    });

    // Fetch last N lines
    const stream = await container.logs({ stdout: true, stderr: true, tail: lines });
    const text = stream.toString('utf8');
    res.type('text/plain; charset=utf-8').send(text);
  } catch (error) {
    if (error.message === 'Sandbox not found') {
      // Already handled, return early
      return;
    }
    logger.error('Error tailing sandbox logs:', error);
    res.status(500).json({ error: 'Failed to fetch sandbox logs' });
  }
});

// Debug: queue and worker status
app.get('/debug/queue', requireAuth, async (req, res) => {
  try {
    const info = await queueService.getDebugInfo();
    res.json(info);
  } catch (error) {
    logger.error('Error getting queue debug info:', error);
    res.status(500).json({ error: 'Failed to get queue debug info' });
  }
});

// Debug: check snapshot object existence in storage (read-only)
app.get('/storage/:id/exists', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const key = `sandbox/${id}/snapshot.tar`;
    // Use storageService via headObject by reusing its S3 client
    await storageService.initialize(); // no-op if already initialized
    storageService.s3.headObject({ Bucket: storageService.bucket, Key: key }).promise()
      .then(data => {
        res.json({ exists: true, key, size: data.ContentLength, etag: data.ETag, lastModified: data.LastModified });
      })
      .catch(err => {
        if (err && (err.code === 'NotFound' || err.statusCode === 404)) {
          return res.status(404).json({ exists: false, key });
        }
        logger.error('Error checking snapshot object:', err);
        res.status(500).json({ error: 'Failed to check object', key });
      });
  } catch (error) {
    logger.error('Error in storage exists endpoint:', error);
    res.status(500).json({ error: 'Failed to verify snapshot existence' });
  }
});

// Debug: Docker daemon connectivity and sandbox container summary
app.get('/debug/docker', requireAuth, async (req, res) => {
  try {
    const doDryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const t0 = Date.now();
    await docker.ping();
    const pingMs = Date.now() - t0;

    const [version, info, sandboxList] = await Promise.all([
      docker.version().catch(() => ({})),
      docker.info().catch(() => ({})),
      docker.listContainers({
        all: true,
        filters: { label: ['sandbox=true'] }
      }).catch(() => [])
    ]);

    const response = {
      ping: true,
      pingMs,
      version: {
        Version: version.Version,
        ApiVersion: version.ApiVersion,
        MinAPIVersion: version.MinAPIVersion,
        GoVersion: version.GoVersion,
        Os: version.Os,
        Arch: version.Arch
      },
      info: {
        ServerVersion: info.ServerVersion,
        OSType: info.OSType,
        OperatingSystem: info.OperatingSystem,
        KernelVersion: info.KernelVersion,
        Containers: info.Containers,
        ContainersRunning: info.ContainersRunning,
        ContainersPaused: info.ContainersPaused,
        ContainersStopped: info.ContainersStopped,
        Images: info.Images
      },
      sandboxContainers: sandboxList.map(c => ({
        id: c.Id,
        name: Array.isArray(c.Names) && c.Names[0] ? c.Names[0].replace('/', '') : '',
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created
      }))
    };

    if (doDryRun) {
      const image = 'node:20-bullseye';
      // Ensure image exists (best-effort)
      try {
        await docker.getImage(image).inspect();
      } catch (_) {
        const pullStream = await docker.pull(image);
        await new Promise((resolve, reject) => {
          docker.modem.followProgress(pullStream, (err) => err ? reject(err) : resolve());
        });
      }

      const rand = crypto.randomBytes(4).toString('hex');
      const name = `sbx-dryrun-${rand}`;
      const createOpts = {
        name,
        Image: image,
        Cmd: ['bash', '-lc', 'sleep 60'], // keep running briefly for exec
        User: 'node',
        WorkingDir: '/work',
        HostConfig: {
          ReadonlyRootfs: true,
          Tmpfs: {
            '/tmp': 'rw,noexec,nosuid,size=32m',
            '/home/node/.local': 'rw,noexec,nosuid,size=32m,uid=1000,gid=1000',
            '/work': 'rw,nosuid,exec,size=32m,uid=1000,gid=1000'
          },
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true']
        },
        Labels: { 'sandbox': 'true', 'sandbox-mode': 'debug' }
      };

      const container = await docker.createContainer(createOpts);
      await container.start();

      // Exec a simple write/read on /work to validate tmpfs + perms
      const execInstance = await container.exec({
        Cmd: ['bash', '-lc', 'echo OK > /work/.probe && cat /work/.probe'],
        AttachStdout: true,
        AttachStderr: true,
        WorkingDir: '/work'
      });

      let stdout = '';
      let stderr = '';
      await new Promise((resolve, reject) => {
        execInstance.start((err, stream) => {
          if (err) return reject(err);
          stream.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
          stream.on('error', reject);
          stream.on('end', resolve);
        });
      });
      const execInfo = await execInstance.inspect().catch(() => ({ ExitCode: null }));

      // Cleanup
      await container.remove({ force: true, v: true }).catch(() => {});

      response.dryRun = {
        image,
        name,
        execExitCode: execInfo.ExitCode,
        execStdout: stdout.trim(),
        execStderr: stderr.trim()
      };
    }

    res.json(response);
  } catch (error) {
    logger.error('Docker debug check failed:', error);
    res.status(500).json({ ping: false, error: error.message });
  }
});

// Smart framework detection for health path
function detectFrameworkHealthPath(files) {
  if (!files || !Array.isArray(files)) return '/health';

  try {
    // Look for package.json to detect framework
    const packageJsonFile = files.find(file => file.path === 'package.json');
    if (!packageJsonFile) return '/health';

    const packageContent = JSON.parse(Buffer.from(packageJsonFile.content, 'base64').toString());
    const dependencies = packageContent.dependencies || {};

    // Simple detection - frameworks that typically serve only root initially
    if (dependencies.next) return '/';
    if (dependencies.nuxt) return '/';
    if (dependencies['react-scripts']) return '/';
    if (dependencies['@vue/cli-service']) return '/';

    // Default to /health for most frameworks
    return '/health';

  } catch (error) {
    console.log('Framework detection failed, defaulting to /health:', error);
    return '/health';
  }
}

// Create sandbox
app.post('/sandbox', async (req, res) => {
  console.log(`POST /sandbox endpoint reached (request ID: ${req.id})`);
  try {
    const {
      mode = 'dev',
      ttlMinutes,
      env,
      files,
      tarUrl,
      healthPath
    } = req.body;

    // Size validation constants (intentional buffer below middleware limits)
    // Express middleware: 10MB (allows large individual files)
    // MAX_TOTAL_SIZE: 8MB (provides 2MB headroom for overhead and safety)
    const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file
    const MAX_TOTAL_SIZE = 8 * 1024 * 1024; // 8MB total limit
    const MAX_FILES = 100; // Maximum number of files

    // Reject non-JSON content types
    if (!req.is('application/json')) {
      return res.status(415).json({
        error: 'Unsupported media type. Only application/json is supported.',
        supported: 'application/json'
      });
    }

    // Validate file limits
    if (files && files.length > 0) {
      if (files.length > MAX_FILES) {
        return res.status(400).json({ error: `Too many files. Maximum ${MAX_FILES} files allowed.` });
      }

      let totalSize = 0;

      for (const file of files) {
        if (!file.path || !file.content) {
          return res.status(400).json({ error: 'Invalid file format: path and content required' });
        }

        const content = Buffer.from(file.content, 'base64');

        if (content.length > MAX_FILE_SIZE) {
          return res.status(413).json({ error: `File ${file.path} exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB` });
        }

        totalSize += content.length;

        if (totalSize > MAX_TOTAL_SIZE) {
          return res.status(413).json({ error: `Total file size exceeds maximum of ${MAX_TOTAL_SIZE / 1024 / 1024}MB` });
        }

        // Validate file path to prevent traversal attacks
        if (path.isAbsolute(file.path) || file.path.split(path.sep).includes('..')) {
          return res.status(400).json({ error: `Invalid file path: ${file.path}` });
        }

        // Block dangerous file types
        const dangerousExtensions = ['exe', 'dll', 'so', 'dylib', 'bin'];
        const extension = file.path.split('.').pop()?.toLowerCase();
        if (extension && dangerousExtensions.includes(extension)) {
          return res.status(400).json({ error: `File type ${extension} not allowed` });
        }
      }
    }

    // Generate sandbox ID - random only for MVP
    const sandboxId = urlGenerator.generate('random', { length: 8 });
    const ttl = ttlMinutes || (mode === 'dev' ?
      parseInt(process.env.DEV_TTL_MINUTES) :
      parseInt(process.env.PROD_TTL_MINUTES));

    // Detect framework and set appropriate health path
    const detectedHealthPath = healthPath || detectFrameworkHealthPath(files || []);
    console.log('Auto-detected healthPath:', detectedHealthPath, 'requested:', healthPath);

    // Prepare sandbox data
    const sandboxData = {
      id: sandboxId,
      mode,
      ttl,
      env: env || {},
      files: files || [],
      tarUrl: tarUrl || null,
      healthPath: detectedHealthPath,
      status: 'pending',
      url: `https://${sandboxId}.${process.env.PREVIEW_DOMAIN}`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttl * 60 * 1000).toISOString()
    };

    // Store snapshot to MinIO if files provided
    if (files && files.length > 0) {
      await storageService.storeSnapshot(sandboxId, files);
    }

    // Add to queue
    await queueService.addToQueue(sandboxData);

    logger.info(`Sandbox ${sandboxId} created and queued`, {
      sandboxId,
      mode,
      ttl,
      fileCount: files ? files.length : 0,
      tarProvided: Boolean(tarUrl),
      envKeys: Object.keys(env || {})
    });

    res.status(202).json({
      id: sandboxId,
      url: sandboxData.url,
      status: 'pending',
      message: 'Sandbox is being provisioned'
    });

  } catch (error) {
    logger.error('Error creating sandbox:', error);
    res.status(500).json({ error: 'Failed to create sandbox' });
  }
});

// Get sandbox status
app.get('/sandbox/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const status = await sandboxManager.getSandboxStatus(id);

    if (!status) {
      return res.status(404).json({ error: 'Sandbox not found' });
    }

    res.json(status);
  } catch (error) {
    logger.error('Error getting sandbox status:', error);
    res.status(500).json({ error: 'Failed to get sandbox status' });
  }
});

// Delete sandbox
app.delete('/sandbox/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await sandboxManager.stopSandbox(id);
    res.json({ message: 'Sandbox stopped successfully' });
  } catch (error) {
    logger.error('Error stopping sandbox:', error);
    res.status(500).json({ error: 'Failed to stop sandbox' });
  }
});

// Get sandbox logs (WebSocket endpoint)
app.get('/sandbox/:id/logs', requireAuth, (req, res) => {
  // This will be handled by WebSocket upgrade
  res.status(400).json({ error: 'Use WebSocket connection for logs' });
});

// WebSocket connection for logs
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sandboxId = url.searchParams.get('sandboxId');
  const authHeader = req.headers['authorization'] || '';

  if (!sandboxId) {
    ws.close(1008, 'Missing sandboxId parameter');
    return;
  }

  if (!authHeader.startsWith('Bearer ') || authHeader.slice(7) !== API_TOKEN) {
    logger.warn('Rejected unauthorized WebSocket connection', { sandboxId: sandboxId || 'unknown' });
    ws.close(1008, 'Unauthorized');
    return;
  }

  logger.info(`WebSocket connection established for sandbox ${sandboxId}`);
  activeConnections.set(sandboxId, ws);

  ws.on('close', () => {
    activeConnections.delete(sandboxId);
    logger.info(`WebSocket connection closed for sandbox ${sandboxId}`);
  });

  ws.on('error', (error) => {
    logger.error(`WebSocket error for sandbox ${sandboxId}:`, error);
    activeConnections.delete(sandboxId);
  });
});

// Functions to send logs to WebSocket clients
function sendLogToClient(sandboxId, message) {
  const ws = activeConnections.get(sandboxId);
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({
      type: 'log',
      sandboxId,
      message,
      timestamp: new Date().toISOString()
    }));
  }
}

// Initialize services
async function initialize() {
  try {
    await queueService.initialize();
    await sandboxManager.initialize({
      queueService,
      storageService,
      sendLogToClient
    });

    // Start TTL cleanup job
    require('./jobs/cleanupJob')();

    logger.info('Sandbox API server initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize server:', error);
    process.exit(1);
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`Sandbox API server running on port ${PORT}`);
  initialize();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down gracefully...');
  await queueService.close();
  await sandboxManager.close();
  server.close(() => {
    logger.info('Server stopped');
    process.exit(0);
  });
});
