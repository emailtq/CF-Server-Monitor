import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { referenceAssets } from './round3-dialogs.mjs';

export async function downloadReferenceAssets(out) {
  const reference = await referenceAssets(out);
  const audit = path.resolve('.planning/2026-11-13-admin-ui-refinement/round2/reference-audit');
  const fixture = path.join(audit, 'dialogs/reference');
  // Only replace the old host's no-op toast boundary; original copy/InstallDialog/ConfirmDialog stay verbatim.
  const entry = fs.readFileSync(path.join(fixture, 'entry.tsx'), 'utf8')
    .replace('const toast={success:()=>{},error:()=>{}};', "import {toast,Toaster} from 'sonner'; window.referenceToast=()=>toast.success('凭证已换发，需用新命令重装'); window.referenceError=()=>toast.error('复制失败'); window.referenceCopy=copy;")
    .replace('return <TooltipProvider><button id="outside"', 'return <TooltipProvider><Toaster position="top-center" theme={dark ? "dark" : "light"}/><button id="outside"');
  await build({ stdin: { contents: entry, resolveDir: fixture, sourcefile: 'actual-download-reference.tsx', loader: 'tsx' }, bundle: true, format: 'iife', outfile: path.join(reference.dir, 'reference.js'), nodePaths: [path.join(audit, 'nodes-shell/reference/node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': path.join(fixture, 'src'), 'radix-ui': path.join(fixture, 'radix.ts') }, jsx: 'automatic' });
  return { ...reference, toast: 'actual installed Sonner 2.0.8; original App.tsx top-center/theme settings' };
}
