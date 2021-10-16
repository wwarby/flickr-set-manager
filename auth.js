'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const parse = require('url').parse;
const Flickr = require('flickr-sdk');

const config = JSON.parse(fs.readFileSync('appsettings.json'));
const oauth = new Flickr.OAuth(config.apiKey, config.apiSecret);

https.createServer({key: fs.readFileSync(path.join(__dirname, 'key.pem')), cert: fs.readFileSync(path.join(__dirname, 'cert.pem'))}, async (req, res) => {
  const url = parse(req.url, true);
  switch (url.pathname) {
    case '/':
      try {
        const authResult = await oauth.request('https://localhost:3000/oauth/callback');
        // Store the request token temporarily
        config.oAuthRequestToken = authResult.body.oauth_token;
        config.oAuthRequestTokenSecret = authResult.body.oauth_token_secret;
        // Redirect the user to Flickr and ask user to authorise app
        res.statusCode = 302;
        res.setHeader('location', oauth.authorizeUrl(config.oAuthRequestToken, 'delete'));
        res.end();
      } catch(e) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain');
        res.end(`${e.message}\r\n\r\n${e.stack}`);
      }
      break;
    case '/oauth/callback':
      try {
        const verifyResult = await oauth.verify(url.query.oauth_token, url.query.oauth_verifier, config.oAuthRequestTokenSecret);
        // Write the user credentials to the config file
        config.userNsid = verifyResult.body.user_nsid;
        config.oauthToken = verifyResult.body.oauth_token;
        config.oauthTokenSecret = verifyResult.body.oauth_token_secret;
        delete config.oAuthRequestToken;
        delete config.oAuthRequestTokenSecret;
        fs.writeFileSync('appsettings.json', JSON.stringify(config, null, 2));
        console.log('Auth token and secret successfully written to appsettings.json');
        res.statusCode = 200;
        res.end('Auth token and secret successfully written to appsettings.json');
      } catch(e) {
        res.statusCode = 400;
        res.setHeader('content-type', 'text/plain');
        res.end(`${e.message}\r\n\r\n${e.stack}`);
      }
      break;
    default:
      res.statusCode = 404;
      res.end();
  }
}).listen(3000, () => console.log('Open your browser to https://localhost:3000'));
