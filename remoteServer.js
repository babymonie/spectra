
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

class RemoteServer {
  constructor(rendererPath, invokeHandler) {
    this.rendererPath = rendererPath;
    this.invokeHandler = invokeHandler;
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = new Server(this.server);
    this.port = 3000;
    this.isRunning = false;

    this.setupRoutes();
    this.setupSocket();
  }

  setupRoutes() {
    // Serve album covers from userData/covers directory
    const coversPath = path.join(app.getPath('userData'), 'covers');
    this.app.use('/covers', express.static(coversPath, {
      setHeaders: (res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400'); // Cache for 1 day
      }
    }));
    
    // Serve images folder (logo, etc.)
    const imagesPath = path.join(path.dirname(this.rendererPath), 'images');
    this.app.use('/images', express.static(imagesPath, {
      setHeaders: (res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
      }
    }));
    
    // Serve static files, but intercept index.html
    this.app.get('/', (req, res) => {
      const indexPath = path.join(this.rendererPath, 'index.html');
      fs.readFile(indexPath, 'utf8', (err, data) => {
        if (err) {
          res.status(500).send('Error loading UI');
          return;
        }
        
        // Inject socket.io and web-client.js
        const injection = `
          <script src="/socket.io/socket.io.js"></script>
          <script src="web-client.js"></script>
        `;
        
        // Insert before the first script tag or before </body>
        const modifiedHtml = data.replace('</body>', `${injection}</body>`);
        res.send(modifiedHtml);
      });
    });

    this.app.use(express.static(this.rendererPath));
  }

  setupSocket() {
    this.io.on('connection', (socket) => {
      console.log('Remote client connected');

      socket.on('invoke', async ({ id, channel, args }) => {
        try {
          const result = await this.invokeHandler(channel, ...args);
          socket.emit('response', { id, result });
        } catch (error) {
          socket.emit('response', { id, error: error.message || error });
        }
      });

      socket.on('disconnect', () => {
        console.log('Remote client disconnected');
      });
    });
  }

  broadcast(channel, ...args) {
    if (this.io) {
      this.io.emit('push-event', { channel, args });
    }
  }

  start(port = 3000) {
    if (this.isRunning) return;
    this.port = port;
    this.server.listen(this.port, () => {
      console.log(`Remote server running on http://localhost:${this.port}`);
      this.isRunning = true;
    });
  }

  stop() {
    if (!this.isRunning) return;
    this.server.close(() => {
      console.log('Remote server stopped');
      this.isRunning = false;
    });
  }
}

export default RemoteServer;
