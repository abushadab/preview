PR ?= curl -sS

.PHONY: prereq auth-test health-observability-test test-size-guard all-tests

prereq:
	@[ -n "$(PREVIEW_DOMAIN)" ] || { echo "❌ PREVIEW_DOMAIN env var must be set"; exit 1; }
	@$(PR) -o /dev/null -w '' -H "Host: api.$(PREVIEW_DOMAIN)" http://127.0.0.1/health >/dev/null \
	  && echo "✅ API healthy" || { echo "❌ API unhealthy"; exit 1; }
	@docker compose exec -T redis redis-cli PING | grep -q PONG \
	  && echo "✅ Redis healthy" || { echo "❌ Redis unhealthy"; exit 1; }
	@$(PR) -o /dev/null -w '' -H "Host: minio.$(PREVIEW_DOMAIN)" http://127.0.0.1/minio/health/live >/dev/null \
	  && echo "✅ MinIO healthy" || { echo "❌ MinIO unhealthy"; exit 1; }

auth-test:
	@[ -n "$(PREVIEW_DOMAIN)" ] || { echo "❌ PREVIEW_DOMAIN env var must be set"; exit 1; }
	@[ -n "$(API_TOKEN)" ] || { echo "❌ Export API_TOKEN before running auth-test"; exit 1; }
	@echo "Testing admin route without auth..."
	@code1=$$($(PR) -o /dev/null -w '%{http_code}' -H "Host: api.$(PREVIEW_DOMAIN)" http://127.0.0.1/sandbox/demo/logs/tail?lines=1); \
	  echo "Unauthenticated status: $$code1";
	@echo "Testing admin route with valid token..."
	@code2=$$($(PR) -o /dev/null -w '%{http_code}' -H "Host: api.$(PREVIEW_DOMAIN)" -H "Authorization: Bearer $(API_TOKEN)" \
	  http://127.0.0.1/sandbox/demo/logs/tail?lines=1); echo "Authorized status: $$code2";

health-observability-test:
	@[ -n "$(PREVIEW_DOMAIN)" ] || { echo "❌ PREVIEW_DOMAIN env var must be set"; exit 1; }
	@response=$$($(PR) -H "Host: api.$(PREVIEW_DOMAIN)" http://127.0.0.1/health); \
	  echo "Health response: $$response"

test-size-guard:
	@[ -n "$(PREVIEW_DOMAIN)" ] || { echo "❌ PREVIEW_DOMAIN env var must be set"; exit 1; }
	@tmpdir=$$(mktemp -d); trap 'rm -rf "$$tmpdir"' EXIT; cd "$$tmpdir"; \
	  python3 -c 'import json, base64; blob = base64.b64encode(b"a" * (2 * 1024 * 1024)).decode();\
print(json.dumps({"files":[{"path":"valid.txt","content":blob}]}))' > sized_payload.json; \
	  code_valid=$$($(PR) -o /dev/null -w '%{http_code}' -X POST -H "Host: api.$(PREVIEW_DOMAIN)" \
	    -H "Content-Type: application/json" --data @sized_payload.json http://127.0.0.1/sandbox); \
	  echo "Valid payload status: $$code_valid"; \
	  python3 -c 'import json, base64; blob = base64.b64encode(b"a" * (12 * 1024 * 1024)).decode();\
print(json.dumps({"files":[{"path":"big.txt","content":blob}]}))' > oversized_payload.json; \
	  code_oversized=$$($(PR) -o /dev/null -w '%{http_code}' -X POST -H "Host: api.$(PREVIEW_DOMAIN)" \
	    -H "Content-Type: application/json" --data @oversized_payload.json http://127.0.0.1/sandbox); \
	  echo "Oversized payload status: $$code_oversized"

all-tests: prereq auth-test health-observability-test test-size-guard
