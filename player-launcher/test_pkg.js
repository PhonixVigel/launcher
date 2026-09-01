const { packager } = require('@electron/packager');
const path = require('path');

console.log('Testing @electron/packager direct call...');
packager({
  dir: path.join(__dirname),
  name: 'VozduCraft',
  platform: 'win32',
  arch: 'x64',
  out: path.join(__dirname, '..', 'dist_win'),
  overwrite: true,
  asar: true,
  prune: false
}).then(paths => {
  console.log('Built to:', paths);
}).catch(err => {
  console.error('Packager failed with:', err);
});
