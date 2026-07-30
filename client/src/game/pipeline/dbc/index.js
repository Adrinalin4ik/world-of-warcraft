import WorkerPool from '../worker/pool';

class DBC {

  static cache = {};

  constructor(data) {
    this.data = data || {};
    this.records = data?.records || [];
    console.log(`DBC: Constructing with ${this.records.length} records`);
    this.index();
    this.modelID = null;
    this.path = null;
    this.file = null;
    this.modelData = null;
  }

  index() {
    this.modelData = this.records?.modelData || null;
    
    if (!Array.isArray(this.records)) {
      console.warn('DBC records is not an array, skipping indexing');
      return;
    }
    
    this.records.forEach(function(record) {
      if (!record || record.id === undefined) {
        return;
      }
      this[record.id] = record;
    }.bind(this));
  }

  static load(name, id) {
    if (!(name in this.cache)) {
      this.cache[name] = WorkerPool.enqueue('DBC', name).then((args) => {
        const data = args;
        return new this(data);
      }).catch((error) => {
        console.error(`Failed to load DBC ${name}:`, error);
        return new this({ records: [] });
      });
    }

    if (id !== undefined) {
      return this.cache[name].then(function(dbc) {
        return dbc[id];
      });
    }

    return this.cache[name];
  }

}

export default DBC;
