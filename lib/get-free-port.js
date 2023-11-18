const { Server } = require('net');

// This works by trying to listen on a port.
// If connecting works then the port is good to use.
// If not the port is busy, try another
async function getFreePort(port) {
  return new Promise((resolve, reject) => {
    const server = new Server();
//    const timeout = () => {
//      resolve(port);
//      socket.destroy();
//    };

    const next = () => {
      server.close();
      resolve(getFreePort(++port));
    };

//    setTimeout(timeout, 1000);
//    server.on("timeout", timeout);
    server.on("listening", () => {
      server.close();
      resolve(port);
    });
    server.on("error", next);

    server.listen({
      port, 
      host: "0.0.0.0",
      exclusive: true,
    });
  });
};

module.exports = getFreePort;
