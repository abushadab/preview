class PathRouter {
  constructor() {
    this.routes = new Map();
  }

  // Store sandbox routes
  addRoute(sandboxId, port) {
    this.routes.set(sandboxId, port);
    console.log(`Added route: /sandbox/${sandboxId} → port ${port}`);
  }

  removeRoute(sandboxId) {
    this.routes.delete(sandboxId);
    console.log(`Removed route: /sandbox/${sandboxId}`);
  }

  // Get port for sandbox
  getPort(sandboxId) {
    return this.routes.get(sandboxId);
  }

  // Generate URL for sandbox
  generateUrl(sandboxId) {
    return `https://sandbox.baytlabs.com/sandbox/${sandboxId}`;
  }

  // Middleware to handle routing
  middleware() {
    return (req, res, next) => {
      if (req.path.startsWith('/sandbox/')) {
        const sandboxId = req.path.split('/')[2];
        const port = this.routes.get(sandboxId);

        if (port) {
          // Proxy to the sandbox
          // This would require a reverse proxy setup
          // For now, redirect or handle appropriately
          return res.redirect(`http://localhost:${port}${req.path.replace(`/sandbox/${sandboxId}`, '')}`);
        }
      }
      next();
    };
  }
}

module.exports = PathRouter;