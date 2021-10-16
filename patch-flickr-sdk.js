const fs = require('fs');
const path = 'node_modules/flickr-sdk/services/rest.js';
const content = fs.readFileSync(path, 'utf8');
const replaced = content.replace(/(\.query\({ method: method }\)\s*?\.):query/g, '$1param');
fs.writeFileSync(path, replaced, 'utf8');
console.log('flickr-sdk bug patched');
