import Promise from 'bluebird';

class Loader {

  constructor() {
    this.prefix = this.prefix || '/pipeline/';
    this.responseType = this.responseType || 'arraybuffer';
  }

  load(path) {
    return new Promise((resolve, _reject) => {
      const uri = `${this.prefix}${path}`;

      fetch(encodeURI(uri), {
        responseType: this.responseType
      }).then(async(res) => {
        const buffer = await res.arrayBuffer();
        resolve(buffer);
      }).catch((ex) => console.error('Loader error', ex));

      // const xhr = new XMLHttpRequest();
      // xhr.open('GET', encodeURI(uri), true);

      // xhr.onload = function(_event) {
      //   // TODO: Handle failure
      //   if (this.status >= 200 && this.status < 400) {
      //     console.log(this.response)
      //     resolve(this.response);
      //   }
      // };
      
      // xhr.responseType = this.responseType;
      // xhr.send();
    });
  }

}

export default Loader;
