import cors from 'cors';
import express from 'express';
import logger from 'morgan';
import Pipeline from './pipeline';

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
    this.app.use(express.static('./public'));
    this.app.use('/pipeline', new Pipeline().router);
  }

  start() {
    this.app.listen(this.port);
  }

}

export default Server;
