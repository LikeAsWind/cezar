import { cp, mkdir, realpath, rm } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(packageRoot, 'src/workflows/assets/superpowers');
const destination = resolve(packageRoot, 'dist/workflows/assets/superpowers');
await mkdir(dirname(destination), { recursive: true });
const physicalParent = relative(await realpath(packageRoot), await realpath(dirname(destination))).replaceAll('\\', '/');
if (physicalParent !== 'dist/workflows/assets' || destination === source) {
  throw new Error('Invalid workflow asset build destination');
}
await rm(destination, { recursive: true, force: true });
await cp(source, destination, { recursive: true });
console.log('copy-workflow-assets ok — skills and upstream assets copied unchanged');
