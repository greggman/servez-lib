const { Server } = require('net');

// This works by trying to listen on a port.
// If connecting works then the port is good to use.
// If not the port is busy, try another
function getFreePort(port, host) {
  return new Promise((resolve, reject) => {
    const server = new Server();

    const next = () => {
      server.close();
      resolve(getFreePort(++port));
    };

    server.on("listening", () => {
      server.close();
      resolve(port);
    });
    server.on("error", next);

    server.listen({
      port, 
      host,
      exclusive: true,
    });
  });
};

module.exports = getFreePort;
