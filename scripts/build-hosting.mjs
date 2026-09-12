import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(projectRoot, 'public');
const filesToPublish = [
    'index.html',
    '404.html',
    'apps.js',
    'order-domain.js',
    'firebase-config.js',
    'WhatsApp Image 2025-09-17 at 16.56.26.jpeg'
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const relativePath of filesToPublish) {
    const sourcePath = join(projectRoot, relativePath);
    const sourceStat = await stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) {
        throw new Error(`Arquivo obrigatório da publicação não encontrado: ${relativePath}`);
    }

    await copyFile(sourcePath, join(outputDirectory, relativePath));
}

console.log(`Pacote de Hosting criado com ${filesToPublish.length} arquivos em ${outputDirectory}.`);
