const { spawn } = require('child_process');
const path = require('path');
const { existsSync } = require('fs');

const child = spawn('npm', ['run', 'start:all'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1536' }
});

child.on('error', (err) => {
    console.error('Erro ao iniciar Node.js:', err.message);
    process.exit(1);
});

child.on('exit', (code) => {
    process.exit(code || 0);
});
