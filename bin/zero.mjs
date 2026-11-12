#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(root, 'node_modules', '.bin', 'tsx');
const child = spawn(tsx, [join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit', cwd: process.cwd() });
child.on('exit', (code) => process.exit(code ?? 1));
