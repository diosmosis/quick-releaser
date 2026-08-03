#!/usr/bin/env node
//
// Stands in for https://api.wordpress.org/plugins/info/1.0 during the tests, so the
// suite can cover the wordpress.org lookup without touching the network.
//
//   node wporg-stub.js '{"wp-piwik":"1.1.9"}' <port-file>
//
// Serves `/<slug>.json` as `{"slug":…,"version":…}` for every slug in the map, and the
// directory's real 404 body for anything else. It listens on a free port and writes the
// base URL to <port-file> once it is actually accepting connections; the test polls for
// that file and passes the URL on as QUICK_RELEASER_WPORG_API.
//
// Every request it answers is appended to <port-file>.requests, so a test can assert
// which slugs were tried, and in what order.

'use strict';

const fs = require('fs');
const http = require('http');

const versions = JSON.parse(process.argv[2] || '{}');
const portFile = process.argv[3];

const server = http.createServer((req, res) => {
	const slug = decodeURIComponent(req.url.replace(/^\//, '').replace(/\.json$/, ''));
	fs.appendFileSync(`${portFile}.requests`, `${slug}\n`);

	if (!Object.prototype.hasOwnProperty.call(versions, slug)) {
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'Plugin not found.' }));
		return;
	}
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ name: slug, slug, version: versions[slug] }));
});

server.listen(0, '127.0.0.1', () => {
	fs.writeFileSync(portFile, `http://127.0.0.1:${server.address().port}`);
});
