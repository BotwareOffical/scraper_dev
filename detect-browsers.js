const fs = require('fs');
const path = require('path');

function findPlaywrightBrowsers() {
  const possiblePaths = [
    // Playwright's default installation paths
    path.join(process.cwd(), 'node_modules/playwright-core/.local-browsers'),
    '/app/node_modules/playwright-core/.local-browsers',
    path.join(process.env.HOME || '/', '.cache/ms-playwright')
  ];

  const foundBrowsers = [];

  possiblePaths.forEach(basePath => {
    try {
      if (fs.existsSync(basePath)) {
        const browserTypes = fs.readdirSync(basePath);
        
        browserTypes.forEach(browserType => {
          const browserPath = path.join(basePath, browserType);
          
          if (fs.statSync(browserPath).isDirectory()) {
            const executables = [
              path.join(browserPath, 'chrome-linux', 'chrome'),
              path.join(browserPath, 'chrome-linux', 'headless_shell'),
              path.join(browserPath, 'chromium'),
              path.join(browserPath, 'chrome')
            ];

            executables.forEach(exe => {
              if (fs.existsSync(exe)) {
                foundBrowsers.push(exe);
              }
            });
          }
        });
      }
    } catch (error) {
      console.error(`Error searching in ${basePath}:`, error);
    }
  });

  return foundBrowsers;
}

// Run detection
const browsers = findPlaywrightBrowsers();
console.log('Detected Playwright Browsers:', browsers);