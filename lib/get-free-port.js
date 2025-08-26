const debug = require('debug')('servez:get-free-port');
const net = require('net');

// This works by trying to listen on a port.
// If connecting works then the port is good to use.
// If not the port is busy, try another
function getFreePort(port, host) {
  debug('getFreePort:', port, host);
  const server = net.createServer(function() {});
  return new Promise((resolve, reject) => {

    const onError = (err) => {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        debug('getFreePort reject error:', err);
        return reject(err);
      } else {
        debug(`port: ${port} in use, trying next`);
        resolve(getFreePort(++port, host));
      }
    };

    const onListen = () => {
      debug('found port:', port);
      server.removeListener('error', onError);
      server.close(() => {
        resolve(port);
      });
    };

    server.once('listening', onListen);
    server.once('error', onError);

    server.listen({
      port, 
      host,
      exclusive: true,
    });
  });
};

module.exports = getFreePort;
