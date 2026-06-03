const debug = require('debug')('servez:get-free-port');
const net = require('net');

// Resolves if `port` can be bound on `host`, rejects with the listen error otherwise.
function tryBind(port, host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen({
      port,
      host,
      exclusive: true,
    });
  });
}

// Find a port that is free on ALL of `hosts` simultaneously, starting at `port`.
//
// Each candidate port must bind on every host before we accept it. If any host
// is busy we bump the port and re-check the whole set -- otherwise we could
// return a port that's free on one host but taken on the one the real server
// actually binds.
//
// `hosts` is required: pass every host the server might bind. For a server that
// binds with no host, pass `getFreePort.commonHosts`, which covers `::`,
// IPv4-any, and IPv4-loopback.
async function getFreePort(port, hosts) {
  if (!hosts || !hosts.length) {
    throw new Error('getFreePort: hosts is required, e.g. getFreePort.commonHosts');
  }
  debug('getFreePort:', port, hosts);
  for (; port <= 65535; ++port) {
    let free = true;
    for (const host of hosts) {
      try {
        await tryBind(port, host);
      } catch (err) {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
          debug('getFreePort reject error:', err);
          throw err;
        }
        debug(`port: ${port} in use on host ${host}, trying next`);
        free = false;
        break;
      }
    }
    if (free) {
      debug('found port:', port);
      return port;
    }
  }
  throw new Error('no free port available');
}

// The hosts a no-host server binding (`::`, dual-stack) needs clear: IPv6-any,
// IPv4-any, and IPv4-loopback. Library-owned so callers don't hard-code the
// list and stay correct if it ever changes.
getFreePort.commonHosts = [undefined, '0.0.0.0', '127.0.0.1'];

module.exports = getFreePort;
