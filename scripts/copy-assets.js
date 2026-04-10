const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

ensureDir(distDir);

// Copy top-level HTML files from src to dist
const entries = fs.readdirSync(srcDir);
for (const name of entries) {
  const srcPath = path.join(srcDir, name);
  const stat = fs.statSync(srcPath);
  if (stat.isFile() && path.extname(name).toLowerCase() === '.html') {
    const destPath = path.join(distDir, name);
    fs.copyFileSync(srcPath, destPath);
    console.log('Copied', name);
  }
}

console.log('Assets copy complete.');
