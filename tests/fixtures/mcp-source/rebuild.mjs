import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLocusArchive } from '../../../src/locus-archive.js';

const source = dirname(fileURLToPath(import.meta.url));
const packages = ['acceptance-mcp-1.0.0', 'acceptance-mcp-port-1.0.0'];

async function collect(root, directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(root, path, files);
    else if (entry.name !== 'LOCUS.md') {
      files.set(relative(root, path).replaceAll('\\', '/'), await readFile(path));
    }
  }
}

for (const name of packages) {
  const root = join(source, name);
  const files = new Map();
  await collect(root, root, files);
  const manifest = await readFile(join(root, 'LOCUS.md'), 'utf8');
  const bytes = Buffer.from(await writeLocusArchive(files, manifest));
  const archive = join(source, '..', name + '.locus');
  if (process.argv.includes('--write')) await writeFile(archive, bytes);
  else if (!bytes.equals(await readFile(archive))) throw new Error(name + ' archive differs');
  console.log(name + ' verified');
}
