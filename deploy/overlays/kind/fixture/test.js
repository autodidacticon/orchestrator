// The fixture project's check: `npm test`, detected from package.json. It takes 5 seconds, so deploy/smoke.sh's process
// probe sees it run, and it fails when README.md is missing or names SMOKE-M5-BREAK (the smoke's M5 step, whose task
// must fail its check: the scripted agent appends "- <taskId> by worker <workerId>" to README.md).
const fs = require('node:fs');

setTimeout(() => {
  if (!fs.existsSync('README.md')) {
    console.log('fixture check: README.md is missing');
    process.exit(1);
  }
  const lines = fs.readFileSync('README.md', 'utf8').split('\n');
  if (lines.some((l) => l.startsWith('- SMOKE-M5-BREAK '))) {
    console.log('fixture check: README.md names a task that breaks the check');
    process.exit(1);
  }
  console.log('fixture check: ok');
}, 5000);
