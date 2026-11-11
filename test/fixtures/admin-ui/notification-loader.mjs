export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare-smtp') return { url: new URL('./notification-smtp.mjs', import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
