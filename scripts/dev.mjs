// Runs the API server (tsx watch) and the Vite dev server side by side.
import { spawn } from 'node:child_process';

const procs = [
  spawn('npx', ['tsx', 'watch', 'server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, JW_DATA_DIR: process.env.JW_DATA_DIR ?? './.data', JW_LOG_PRETTY: '1' },
  }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
];

const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) stop(); }));
