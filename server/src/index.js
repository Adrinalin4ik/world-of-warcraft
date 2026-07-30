import cors from 'cors';
import express from 'express';
import logger from 'morgan';

class Server {

  constructor(port, root = process.pwd) {
    this.port = port;
    this.root = root;

    this.app = express();

    const cors_settings = {
      "allowedMethods": [
        "GET",
        "POST",
        "OPTIONS"
      ],
      "allowedCredentials": true,
      "allowedHeaders": [
        "Content-Type",
        "Content-Language",
        "Authorization",
        "X-Authorization",
        "Origin",
        "Accept",
        "Accept-Language"
      ]
    };

    const cors_options_delegate = (req, callback) => {
      const cors_options = {
        methods: cors_settings.allowedMethods,
        credentials: cors_settings.allowedCredentials,
        origin: true,
      };
      const error = null;
      
      callback(error, cors_options);
    };

    this.app.use(cors(cors_options_delegate));
    this.app.options('*', cors(cors_options_delegate))

    this.app.set('root', this.root);
    this.app.use(logger('dev'));
    // The /pipeline routes are gone: the client fetches game assets straight from the host in
    // REACT_APP_DATA_URI rather than having them extracted from local MPQ archives on demand.
    this.app.use(express.static('./public'));
  }

  start() {
    this.app.listen(this.port);
  }

}

export default Server;
