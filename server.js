const http = require("http");
http.createServer((_, res) => {
  res.end("OK ONE-SHOT");
}).listen(3000);
