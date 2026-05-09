# Kubernetes manifests

Deployment for the SSE server, ingress, TLS, and Redis Helm overrides.

## Files

| File | Purpose |
|---|---|
| `sse-server.yaml` | SSE server Deployment + ClusterIP Service |
| `sse-ingress.yaml` | nginx Ingress + cert-manager TLS |
| `cluster-issuer.yaml` | cert-manager `ClusterIssuer` (Let's Encrypt DNS-01 via Linode webhook) |
| `redis-values.yaml` | Bitnami Redis Helm chart overrides (1Gi PVC, no replica) |
| `redis-secret.yaml` | gitignored — Redis password secret |

## Required secrets

Created via `kubectl` — never committed:

```bash
# Redis password
kubectl create secret generic redis-secret \
  --from-literal=password=YOUR_REDIS_PASSWORD

# Internal token (shared secret between Function and SSE server)
kubectl create secret generic internal-token \
  --from-literal=token=YOUR_INTERNAL_TOKEN

# Linode API token for cert-manager DNS-01
kubectl create secret generic linode-credentials \
  --namespace cert-manager \
  --from-literal=token=YOUR_LINODE_API_TOKEN
```

## Install Redis (with persistence)

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install redis bitnami/redis -f redis-values.yaml \
  --set auth.password=YOUR_REDIS_PASSWORD
```

Re-creating the StatefulSet (e.g. enabling persistence on an existing install) requires `helm uninstall redis` first — Kubernetes forbids most StatefulSet spec mutations.

## Deploy SSE server

```bash
kubectl apply -f cluster-issuer.yaml   # once, after cert-manager is installed
kubectl apply -f sse-server.yaml
kubectl apply -f sse-ingress.yaml
```

## Architecture notes

- **IPACL**: the LKE cluster only accepts traffic on 443 from Akamai edge IPs. The SSE server is reachable only via the CDN.
- **Persistence**: Redis uses a `PersistentVolumeClaim` (Linode block storage, retain policy). Sessions and questions persist across pod restarts.
- **Health probes** hit `/voterapp/api/health` (the SSE server's BASE prefix).

See [`docs/architecture.md`](../docs/architecture.md) for the full picture.
