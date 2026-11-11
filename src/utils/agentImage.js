import { AGENT_REPOSITORY } from '../shared/agentSource.js';

const cache = new Map();
export async function checkAgentImage(tag = 'latest', request = fetch) {
  if (typeof tag !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) return {available:false};
  const held = cache.get(tag);
  if (request === fetch && held?.until > Date.now()) return held.value;
  let available = false;
  try {
    const options = {redirect:'error', signal:AbortSignal.timeout(10000)};
    const tokenResponse = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${AGENT_REPOSITORY}:pull`, options);
    if (!tokenResponse.ok) throw new Error();
    const {token} = await tokenResponse.json();
    if (typeof token !== 'string' || !token) throw new Error();
    const response = await request(`https://ghcr.io/v2/${AGENT_REPOSITORY}/manifests/${tag}`, {...options, headers:{Authorization:`Bearer ${token}`, Accept:'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'}});
    if (!response.ok) throw new Error();
    const manifest = await response.json();
    available = manifest.schemaVersion === 2 && !!(manifest.manifests?.length || manifest.config?.digest);
  } catch (_) { /* Registry errors never expose upstream tokens or response bodies. */ }
  const value = {available};
  if (request === fetch) cache.set(tag, {value, until:Date.now()+60000});
  return value;
}
