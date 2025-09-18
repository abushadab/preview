# Security Guide for Preview Sandbox Platform

## ⚠️ Critical Security Considerations

### Docker Socket Mount Risk
The API service mounts `/var/run/docker.sock` which provides full Docker daemon access:
```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

**This is a significant security risk if exposed to the internet.**

#### Mitigations in Place:
✅ **Auth Middleware**: All admin endpoints (logs, inspect, debug) require valid API_TOKEN
✅ **IP Allowlist**: Traefik restricts admin routes to localhost & private networks (127.0.0.1/32, 172.16.0.0/12)
✅ **Traefik Routing**: Admin routes use separate router with additional restrictions
✅ **Rate Limiting**: 100 requests per minute with 20 burst limit
✅ **No Public Debug Access**: All `/sandbox/:id/{inspect,logs}`, `/debug/*`, `/storage/*` are auth-protected

#### Production Recommendations:
1. **Never expose this service directly to the internet**
2. **Use a dedicated VPC/private network** for this service
3. **Implement additional network-level firewalling**
4. **Rotate API_TOKEN regularly** using Docker secrets
5. **Audit Docker API access logs** for suspicious activity
6. **Consider read-only Docker socket** if full functionality isn't needed

### API_TOKEN Security
- **Storage**: Currently stored in `.env` file
- **Best Practice**: Use Docker secrets for production: `echo "$API_TOKEN" | docker secret create api_token -`
- **Production**: Use `_FILE` variant: `API_TOKEN_FILE=/run/secrets/api_token`
- **Rotation**: Implement automated token rotation on deploys
- **Access**: Restrict `.env` file permissions to `600`
- **Audit**: Rotate tokens on compromised host or staff turnover

### Network Isolation Requirements:
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Public Web    │    │   Load Balancer │    │   API Service   │
│                 │────│    (Traefik)    │────│                 │
│ Port 80/443    │    │                 │    │ Port 3001       │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                        │
                                                        ▼
                              ┌─────────────────────────────────┐
                              │     Private Network Zone       │
                              │  ┌─────────────────┐          │
                              │  │   Docker Daemon│          │
                              │  │                 │          │
                              │  │    Socket      │          │
                              │  └─────────────────┘          │
                              └─────────────────────────────────┘
```

### Required Production Architecture:
1. **DMZ Layer**: Public web traffic only (Port 80/443)
2. **Application Layer**: Traefik + API Service (Private network only)
3. **Docker Layer**: Docker daemon on isolated network segment
4. **Database Layer**: Redis + MinIO on separate segment

### Environmental Segmentation:
- **Staging**: Complete replica with reduced scope
- **Production**: Full isolation, hardened configuration
- **Development**: Local only, docker-compose with warning banner

### Monitoring & Alerting:
1. **Auth Failures**: Alert on repeated 401/403 responses
2. **Rate Limit Hits**: Alert when rate limits are exceeded
3. **Unusual Activity**: Monitor for unexpected docker operations
4. **Resource Usage**: Monitor container/resource abuse

### Incident Response:
1. **Immediate**: Revoke API_TOKEN, restart stacks
2. **Containment**: Isolate affected services
3. **Investigation**: Audit Docker logs, API access logs
4. **Recovery**: Rotate all secrets, regenerate certificates

### Compliance:
- **GDPR**: Log retention policy, data minimization
- **SOC2**: Access controls, audit trails
- **PCI**: If applicable, implement additional segmentation

Remember: **Docker socket access = host root access**. Treat it accordingly.

## Secure Deployment Checklist

- [ ] API_TOKEN changed from default values
- [ ] Docker sock mounted read-only (`:ro`) if possible
- [ ] Traefik IP allowlist configured for internal networks only
- [ ] Rate limiting enabled and tested
- [ ] All auth endpoints are protected
- [ ] No direct port exposure to internet (remove `ports:` mapping)
- [ ] Network segmentation implemented
- [ ] Monitoring and alerting configured
- [ ] Incident response procedures documented
- [ ] Regular security audits scheduled