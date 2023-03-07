const { Socket } = require('net');

// This works by trying to connect to a port.
// If connecting works then the port is in use
// If not the port is free
async function getFreePort(port) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const timeout = () => {
      resolve(port);
      socket.destroy();
    };

    const next = () => {
      socket.destroy();
      resolve(getFreePort(++port));
    };

    setTimeout(timeout, 10);
    socket.on("timeout", timeout);
    socket.on("connect", () => next());
    socket.on("error", error => {
      if (error.code !== "ECONNREFUSED")
        reject(error);
      else
        resolve(port);
    });

    socket.connect(port, "0.0.0.0");
  });
};

module.exports = getFreePort;
